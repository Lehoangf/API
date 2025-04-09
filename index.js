const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs').promises;
const app = express();
const port = 3000;

app.use(express.json());
app.use(cors({ origin: '*' }));

// Đường dẫn tới file JSON lưu trữ đơn hàng
const ordersFile = 'orders.json';

// Hàm đọc dữ liệu từ file JSON
async function readOrders() {
  try {
    const data = await fs.readFile(ordersFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
}

// Hàm ghi dữ liệu vào file JSON
async function writeOrders(orders) {
  await fs.writeFile(ordersFile, JSON.stringify(orders, null, 2), 'utf8');
}

// Tạo mã QR cho đơn hàng với orderId và Price
app.get('/generate-qr/:orderId', async (req, res) => {
  const orderId = req.params.orderId;
  const price = parseInt(req.query.Price, 10); // Lấy Price từ query string

  if (!price || isNaN(price) || price <= 0) {
    console.warn(`Price không hợp lệ cho đơn hàng ${orderId}:`, req.query.Price);
    return res.status(400).json({ error: 'Price phải là số nguyên dương' });
  }

  console.log(`Nhận yêu cầu tạo QR cho đơn hàng: ${orderId} với giá: ${price}`);

  const qrData = {
    accountNo: '0905290338',
    accountName: 'DANG LE HOANG',
    acqId: '963388',
    amount: price, // Sử dụng Price từ query
    addInfo: orderId,
    format: 'text',
    template: 'qr_only'
  };

  try {
    console.log('Gửi yêu cầu tới VietQR:', qrData);
    const response = await axios.post('https://api.vietqr.io/v2/generate', qrData, {
      headers: {
        'x-client-id': 'YOUR_CLIENT_ID', // Thay bằng Client ID thực tế
        'x-api-key': 'YOUR_API_KEY', // Thay bằng API Key thực tế
        'Content-Type': 'application/json',
      },
    });
    console.log('Phản hồi từ VietQR:', response.data);
    res.json({ qrCode: response.data.data.qrDataURL });
  } catch (error) {
    console.error('Lỗi khi tạo QR:', {
      message: error.message,
      response: error.response ? error.response.data : null,
      stack: error.stack
    });
    res.status(500).json({ error: error.message });
  }
});

// API đợi xác nhận thanh toán
let pendingOrders = new Map();

app.post('/confirm-payment', async (req, res) => {
  const { orderId, price } = req.body; // Nhận cả price từ client
  console.log(`Nhận yêu cầu xác nhận thanh toán cho đơn hàng: ${orderId} với giá: ${price}`);

  if (!orderId || !price || isNaN(price) || price <= 0) {
    console.warn('Order ID hoặc Price không hợp lệ:', req.body);
    return res.status(400).json({ success: false, message: 'Order ID và Price phải hợp lệ' });
  }

  const orderData = {
    status: 'pending',
    timestamp: Date.now(),
    price: parseInt(price, 10), // Lưu price vào dữ liệu đơn hàng
  };
  pendingOrders.set(orderId, { ...orderData, res });
  console.log(`Đơn hàng ${orderId} được đặt vào trạng thái chờ`);

  // Lưu vào file JSON
  const orders = await readOrders();
  orders[orderId] = orderData;
  await writeOrders(orders);
  console.log(`Đã lưu đơn hàng ${orderId} vào orders.json`);

  setTimeout(async () => {
    const order = pendingOrders.get(orderId);
    if (order && order.status === 'pending') {
      console.log(`Hết thời gian chờ cho đơn hàng: ${orderId}`);
      order.status = 'timeout';
      order.res.status(408).json({
        success: false,
        message: 'Hết thời gian chờ thanh toán, đang chờ xác nhận muộn'
      });
      const updatedOrders = await readOrders();
      updatedOrders[orderId].status = 'timeout';
      await writeOrders(updatedOrders);
      console.log(`Đã cập nhật trạng thái timeout cho ${orderId} trong orders.json`);
    }
  }, 300000); // 300 giây
});

// API nhận callback từ Flutter
app.post('/payment-callback', async (req, res) => {
  console.log('Nhận callback từ Flutter:', req.body);
  const { STK, "SỐ TIỀN": amount, "NGÂN HÀNG": bank, text } = req.body;

  console.log('Danh sách đơn hàng đang chờ:', [...pendingOrders.keys()]);
  const orderId = [...pendingOrders.keys()].find(id =>
    text.toLowerCase().includes(id.toLowerCase())
  );

  if (orderId && pendingOrders.has(orderId)) {
    const order = pendingOrders.get(orderId);
    const expectedAmountString = `+${order.price.toLocaleString('vi-VN')} VND`; // Dựa trên price của đơn hàng

    // Chuẩn hóa và lọc chuỗi
    const normalizeAndFilterAmount = (str) => {
      const normalized = str.replace(/[\.,]/g, ',');
      const filtered = normalized.split(',')[0] + ' VND';
      return filtered;
    };

    const normalizedExpected = normalizeAndFilterAmount(expectedAmountString); // Ví dụ: +5,000 VND
    const normalizedActual = normalizeAndFilterAmount(amount);

    if (normalizedActual === normalizedExpected) {
      console.log(`Số tiền khớp: ${amount} (chuẩn hóa và lọc: ${normalizedActual})`);
      if (text.toLowerCase().includes(orderId.toLowerCase())) {
        console.log(`Tìm thấy đơn hàng khớp: ${orderId}`);
        order.status = 'completed';
        order.res.status(200).json({
          success: true,
          message: `Thanh toán thành công cho đơn hàng ${orderId}`
        });
        pendingOrders.delete(orderId);

        const orders = await readOrders();
        orders[orderId].status = 'completed';
        orders[orderId].completedAt = Date.now();
        await writeOrders(orders);
        console.log(`Đã cập nhật trạng thái completed cho ${orderId} trong orders.json`);
      } else {
        console.warn(`Không tìm thấy orderId trong text:`, { text, orderId });
      }
    } else {
      console.warn(`Số tiền không khớp với ${expectedAmountString}:`, { amount, normalizedActual });
    }
  } else {
    console.warn('Không tìm thấy đơn hàng khớp trong pendingOrders:', { text, pendingOrders: [...pendingOrders.keys()] });

    const orders = await readOrders();
    if (orders[orderId] && (orders[orderId].status === 'pending' || orders[orderId].status === 'timeout')) {
      const expectedAmountString = `+${orders[orderId].price.toLocaleString('vi-VN')} VND`;
      const normalizedExpected = normalizeAndFilterAmount(expectedAmountString);
      const normalizedActual = normalizeAndFilterAmount(amount);

      if (normalizedActual === normalizedExpected && text.toLowerCase().includes(orderId.toLowerCase())) {
        console.log(`Callback muộn khớp với đơn hàng ${orderId} trong orders.json`);
        orders[orderId].status = 'completed';
        orders[orderId].completedAt = Date.now();
        await writeOrders(orders);
        console.log(`Đã cập nhật trạng thái completed cho ${orderId} trong orders.json (callback muộn)`);
      }
    }
  }

  res.status(200).json({ success: true, message: 'Callback nhận thành công' });
});

app.get('/', (req, res) => {
  console.log('Phục vụ trang index.html');
  res.sendFile(__dirname + '/index.html');
});

app.listen(port, () => {
  console.log(`Web server chạy tại http://localhost:${port}`);
});
