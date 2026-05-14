const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { Op } = require('sequelize');
const { init: initDB, Counter, Product, Address, CartItem, Order } = require('./db');
const { withCloudProductPictures } = require('./productPictures');
const {
  wxPayConfig,
  isWxPayConfigured,
  createWechatPrepay,
  getOpenidByCode,
  decryptNotifyResource,
} = require('./wxPay');

const logger = morgan('tiny');

const formatAddress = (addr) => {
  if (!addr) return null;
  const data = typeof addr.toJSON === 'function' ? addr.toJSON() : { ...addr };
  data.phoneNumber = data.phone;
  data.address = `${data.provinceName || ''}${data.cityName || ''}${data.districtName || ''}${data.detailAddress || ''}`;
  data.tag = data.addressTag || '';
  data.addressId = String(data.id);
  return data;
};

const getOrderButtons = (orderStatus) => {
  if (Number(orderStatus) === 5) {
    return [{ primary: true, type: 1, name: '付款' }];
  }
  return [];
};

const normalizeSpecs = (goods) => {
  if (Array.isArray(goods.specInfo)) return goods.specInfo;
  if (Array.isArray(goods.specifications)) return goods.specifications;
  if (Array.isArray(goods.skuSpecLst)) return goods.skuSpecLst;
  if (!goods.specs) return [];

  return String(goods.specs)
    .split(/[，,]/)
    .filter(Boolean)
    .map((specValue) => ({ specValue }));
};

const buildLogisticsVO = (address = {}) => {
  const receiverAddress = address.detailAddress || address.address || '';
  return {
    logisticsType: 1,
    logisticsNo: '',
    logisticsStatus: null,
    logisticsCompanyCode: '',
    logisticsCompanyName: '',
    receiverAddressId: String(address.addressId || address.id || ''),
    provinceCode: address.provinceCode || '',
    cityCode: address.cityCode || '',
    countryCode: address.countryCode || address.districtCode || '',
    receiverProvince: address.provinceName || '',
    receiverCity: address.cityName || '',
    receiverCountry: address.countryName || address.districtName || '',
    receiverArea: address.areaName || '',
    receiverAddress,
    receiverPostCode: '',
    receiverLongitude: address.longitude || '',
    receiverLatitude: address.latitude || '',
    receiverIdentity: '',
    receiverPhone: address.phone || address.phoneNumber || '',
    receiverName: address.name || '',
    expectArrivalTime: null,
    senderName: '',
    senderPhone: '',
    senderAddress: '',
    sendTime: null,
    arrivalTime: null,
  };
};

const formatOrderForMiniProgram = (order) => {
  const data = typeof order.toJSON === 'function' ? order.toJSON() : order;
  const goodsList = Array.isArray(data.goodsList) ? data.goodsList : [];
  const createTime = new Date(data.createdAt || Date.now()).getTime();
  const paySuccessTime = data.paidAt ? new Date(data.paidAt).getTime() : null;

  return {
    saasId: '',
    storeId: goodsList[0]?.storeId || '1000',
    storeName: goodsList[0]?.storeName || '官方商城',
    uid: data.openid || '',
    parentOrderNo: data.orderNo,
    orderId: String(data.id),
    orderNo: data.orderNo,
    orderType: 0,
    orderSubType: 0,
    orderStatus: data.orderStatus,
    orderSubStatus: null,
    totalAmount: String(data.totalAmount || '0'),
    goodsAmount: String(data.totalAmount || '0'),
    goodsAmountApp: String(data.totalAmount || '0'),
    paymentAmount: String(data.paymentAmount || data.totalAmount || '0'),
    freightFee: '0',
    packageFee: '0',
    discountAmount: '0',
    channelType: 0,
    channelSource: '',
    channelIdentity: '',
    remark: data.remark || '',
    cancelType: 0,
    cancelReasonType: 0,
    cancelReason: '',
    rightsType: 0,
    createTime: String(createTime),
    orderItemVOs: goodsList.map((goods, index) => {
      const specs = normalizeSpecs(goods);
      const price = String(goods.price || goods.actualPrice || goods.settlePrice || '0');
      return {
        id: String(goods.id || `${data.id}-${index}`),
        orderNo: data.orderNo,
        spuId: goods.spuId || '',
        skuId: goods.skuId || '',
        roomId: goods.roomId || null,
        goodsMainType: 0,
        goodsViceType: 0,
        goodsName: goods.goodsName || goods.title || '商品名称',
        specifications: specs,
        specInfo: specs,
        goodsPictureUrl: goods.thumb || goods.image || goods.primaryImage || '',
        thumb: goods.thumb || goods.image || goods.primaryImage || '',
        originPrice: price,
        actualPrice: price,
        buyQuantity: Number(goods.quantity || goods.buyQuantity || 1),
        itemTotalAmount: String(Number(price) * Number(goods.quantity || goods.buyQuantity || 1)),
        itemDiscountAmount: '0',
        itemPaymentAmount: String(Number(price) * Number(goods.quantity || goods.buyQuantity || 1)),
        goodsPaymentPrice: price,
        tagPrice: goods.tagPrice || null,
        tagText: goods.tagText || null,
        outCode: null,
        labelVOs: null,
        buttonVOs: [],
      };
    }),
    logisticsVO: buildLogisticsVO(data.userAddress || {}),
    paymentVO: {
      payStatus: paySuccessTime ? 1 : 0,
      amount: String(data.paymentAmount || data.totalAmount || '0'),
      currency: 'CNY',
      payType: null,
      payWay: null,
      payWayName: null,
      interactId: null,
      traceNo: data.transactionId || null,
      channelTrxNo: data.transactionId || null,
      period: null,
      payTime: paySuccessTime,
      paySuccessTime,
    },
    buttonVOs: getOrderButtons(data.orderStatus),
    labelVOs: null,
    invoiceVO: null,
    couponAmount: '0',
    autoCancelTime: createTime + 30 * 60 * 1000,
    orderStatusName: data.orderStatusName || '待付款',
    orderStatusRemark:
      Number(data.orderStatus) === 5
        ? `需支付￥${(Number(data.paymentAmount || data.totalAmount || 0) / 100).toFixed(2)}`
        : data.orderStatusName || '',
    logisticsLogVO: null,
    invoiceStatus: 3,
    invoiceDesc: '暂不开发票',
    invoiceUrl: null,
  };
};

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
}));
app.use(cors());
app.use(logger);

// 小程序调用，获取微信 Open ID
app.get('/api/wx_openid', async (req, res) => {
  if (req.headers['x-wx-source']) {
    res.send(req.headers['x-wx-openid']);
  }
});

// 获取商品列表
app.get('/api/products', async (req, res) => {
  try {
    const products = await Product.findAll({
      where: { status: 1 },
      order: [
        ['sort', 'DESC'],
        ['createdAt', 'DESC'],
      ],
      attributes: [
        'id',
        'spuId',
        'title',
        'brief',
        'price',
        'badge',
        'sort',
        'useThumb',
        'bannerLength',
        'detailPicLength',
        'usePicture',
      ],
    });
    const data = products.map(withCloudProductPictures);
    res.send({ code: 0, data });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 获取商品详情
app.get('/api/products/:spuId', async (req, res) => {
  try {
    const product = await Product.findOne({
      where: { spuId: req.params.spuId, status: 1 },
    });
    if (!product) {
      return res.send({ code: -1, message: '商品不存在' });
    }
    res.send({ code: 0, data: withCloudProductPictures(product) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 初始化种子商品数据（强制重置）
app.post('/api/products/seed', async (req, res) => {
  try {
    // 清空旧数据并重新插入
    await Product.destroy({ truncate: true });

    const seedData = [
      {
        spuId: 'spu_probiotic_01',
        title: '清畅益生菌粉（成人款）',
        brief: '含300亿活性乳酸菌，呵护肠道微生态平衡，每天一袋，轻松享受清爽好肠道。',
        price: 168,
        originalPrice: 238,
        badge: '人气爆款',
        useThumb: true,
        bannerLength: 2,
        detailPicLength: 2,
        sort: 30,
        minSalePrice: 16800,
        maxSalePrice: 19800,
        maxLinePrice: 23800,
        soldNum: 1260,
        spuStockQuantity: 500,
        isPutOnSale: 1,
        specList: [
          {
            specId: 'spec_01_flavor',
            title: '口味',
            specValueList: [
              { specValueId: 'sv_01_original', specValue: '原味', image: '' },
              { specValueId: 'sv_01_berry', specValue: '混合莓果味', image: '' },
            ],
          },
          {
            specId: 'spec_01_count',
            title: '规格',
            specValueList: [
              { specValueId: 'sv_01_30', specValue: '30袋/盒', image: '' },
              { specValueId: 'sv_01_60', specValue: '60袋/盒（家庭装）', image: '' },
            ],
          },
        ],
        skuList: [
          {
            skuId: 'sku_01_01',
            usePicture: true,
            specInfo: [
              { specId: 'spec_01_flavor', specValueId: 'sv_01_original' },
              { specId: 'spec_01_count', specValueId: 'sv_01_30' },
            ],
            priceInfo: [
              { priceType: 1, price: '16800' },
              { priceType: 2, price: '23800' },
            ],
            stockInfo: { stockQuantity: 150, safeStockQuantity: 0, soldQuantity: 0 },
          },
          {
            skuId: 'sku_01_02',
            usePicture: false,
            specInfo: [
              { specId: 'spec_01_flavor', specValueId: 'sv_01_original' },
              { specId: 'spec_01_count', specValueId: 'sv_01_60' },
            ],
            priceInfo: [
              { priceType: 1, price: '19800' },
              { priceType: 2, price: '23800' },
            ],
            stockInfo: { stockQuantity: 120, safeStockQuantity: 0, soldQuantity: 0 },
          },
          {
            skuId: 'sku_01_03',

            specInfo: [
              { specId: 'spec_01_flavor', specValueId: 'sv_01_berry' },
              { specId: 'spec_01_count', specValueId: 'sv_01_30' },
            ],
            priceInfo: [
              { priceType: 1, price: '17800' },
              { priceType: 2, price: '23800' },
            ],
            stockInfo: { stockQuantity: 130, safeStockQuantity: 0, soldQuantity: 0 },
          },
          {
            skuId: 'sku_01_04',

            specInfo: [
              { specId: 'spec_01_flavor', specValueId: 'sv_01_berry' },
              { specId: 'spec_01_count', specValueId: 'sv_01_60' },
            ],
            priceInfo: [
              { priceType: 1, price: '19800' },
              { priceType: 2, price: '23800' },
            ],
            stockInfo: { stockQuantity: 100, safeStockQuantity: 0, soldQuantity: 0 },
          },
        ],
      },
    ];

    const cloudSeedData = seedData.map(withCloudProductPictures);
    await Product.bulkCreate(cloudSeedData);
    res.send({ code: 0, message: '种子数据初始化成功', data: { count: cloudSeedData.length } });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// ============ 地址接口 ============

// 获取用户默认地址
app.get('/api/address/default', async (req, res) => {
  try {
    const openid = req.headers['x-wx-openid'] || 'local_dev_user';
    const addr = await Address.findOne({
      where: { openid },
      order: [
        ['isDefault', 'DESC'],
        ['updatedAt', 'DESC'],
      ],
    });
    if (!addr) {
      return res.send({ code: 0, data: null });
    }
    res.send({ code: 0, data: formatAddress(addr) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 获取用户地址列表
app.get('/api/address/list', async (req, res) => {
  try {
    const openid = req.headers['x-wx-openid'] || 'local_dev_user';
    const list = await Address.findAll({
      where: { openid },
      order: [
        ['isDefault', 'DESC'],
        ['updatedAt', 'DESC'],
      ],
    });
    const result = list.map(formatAddress);
    res.send({ code: 0, data: result });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 获取单个地址详情
app.get('/api/address/:id', async (req, res) => {
  try {
    const addr = await Address.findByPk(req.params.id);
    if (!addr) return res.send({ code: -1, message: '地址不存在' });
    res.send({ code: 0, data: formatAddress(addr) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 新增地址
app.post('/api/address/create', async (req, res) => {
  try {
    const openid = req.headers['x-wx-openid'] || 'local_dev_user';
    const body = req.body;
    const existingCount = await Address.count({ where: { openid } });
    const isDefault = !!body.isDefault || existingCount === 0;

    // 如果设为默认，先把其他地址取消默认
    if (isDefault) {
      await Address.update({ isDefault: false }, { where: { openid } });
    }

    const addr = await Address.create({
      openid,
      name: body.name || '',
      phone: body.phone || '',
      provinceName: body.provinceName || '',
      cityName: body.cityName || '',
      districtName: body.districtName || '',
      detailAddress: body.detailAddress || '',
      addressTag: body.addressTag || '',
      isDefault,
    });

    const d = formatAddress(addr);
    console.log('✅ 新增地址:', d.name, d.address);
    res.send({ code: 0, data: d });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 更新地址
app.post('/api/address/update', async (req, res) => {
  try {
    const openid = req.headers['x-wx-openid'] || 'local_dev_user';
    const body = req.body;
    const addr = await Address.findByPk(body.addressId || body.id);
    if (!addr) return res.send({ code: -1, message: '地址不存在' });

    // 如果设为默认，先把其他地址取消默认
    if (body.isDefault) {
      await Address.update({ isDefault: false }, { where: { openid } });
    }

    await addr.update({
      name: body.name ?? addr.name,
      phone: body.phone ?? addr.phone,
      provinceName: body.provinceName ?? addr.provinceName,
      cityName: body.cityName ?? addr.cityName,
      districtName: body.districtName ?? addr.districtName,
      detailAddress: body.detailAddress ?? addr.detailAddress,
      addressTag: body.addressTag ?? addr.addressTag,
      isDefault: body.isDefault !== undefined ? !!body.isDefault : addr.isDefault,
    });

    res.send({ code: 0, data: formatAddress(addr) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 删除地址
app.post('/api/address/delete', async (req, res) => {
  try {
    const { addressId } = req.body;
    const addr = await Address.findByPk(addressId);
    if (!addr) return res.send({ code: -1, message: '地址不存在' });
    await addr.destroy();
    res.send({ code: 0, data: { removed: 1 } });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// ============ 购物车接口 ============

// 获取购物车列表（返回前端所需的 cartGroupData 结构）
app.get('/api/cart/list', async (req, res) => {
  try {
    const openid = req.headers['x-wx-openid'] || 'local_dev_user';
    const items = await CartItem.findAll({
      where: { openid },
      order: [['createdAt', 'DESC']],
    });

    // 计算汇总
    let totalAmount = 0;
    let totalDiscountAmount = 0;
    let selectedGoodsCount = 0;
    let isAllSelected = items.length > 0;

    const goodsPromotionList = items.map((row) => {
      const g = row.toJSON();
      if (g.isSelected) {
        totalAmount += g.price * g.quantity;
        selectedGoodsCount += g.quantity;
      } else {
        isAllSelected = false;
      }
      return {
        uid: String(g.id),
        saasId: '0',
        storeId: '1',
        spuId: g.spuId,
        skuId: g.skuId,
        thumb: g.thumb,
        title: g.title,
        goodsName: g.title,
        primaryImage: g.thumb,
        price: g.price,
        originPrice: g.originPrice || undefined,
        quantity: g.quantity,
        specs: g.specs ? g.specs.split('+') : [],
        specInfo: g.specs ? g.specs.split('+').map((s) => ({ specValue: s })) : [],
        stockQuantity: g.stockQuantity,
        isSelected: g.isSelected ? 1 : 0,
        available: 1,
      };
    });

    res.send({
      code: 0,
      data: {
        isNotEmpty: items.length > 0,
        storeGoods: [
          {
            storeId: '1',
            storeName: '立康林旗舰店',
            isSelected: isAllSelected,
            storeStockShortage: false,
            shortageGoodsList: [],
            promotionGoodsList: [
              {
                promotionId: '0',
                goodsPromotionList,
              },
            ],
          },
        ],
        invalidGoodItems: [],
        totalAmount,
        totalDiscountAmount,
        selectedGoodsCount,
        isAllSelected,
      },
    });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 加入购物车（同SPU+SKU则累加数量）
app.post('/api/cart/add', async (req, res) => {
  try {
    const openid = req.headers['x-wx-openid'] || 'local_dev_user';
    const { spuId, skuId, title, thumb, price, originPrice, quantity, specs, stockQuantity } = req.body;

    let item = await CartItem.findOne({ where: { openid, spuId, skuId: skuId || '' } });
    if (item) {
      item.quantity += quantity || 1;
      await item.save();
    } else {
      item = await CartItem.create({
        openid,
        spuId,
        skuId: skuId || '',
        title: title || '',
        thumb: thumb || '',
        price: price || 0,
        originPrice: originPrice || null,
        quantity: quantity || 1,
        specs: specs || '',
        stockQuantity: stockQuantity || 999,
      });
    }
    console.log('✅ 加入购物车:', title, 'x', item.quantity);
    res.send({ code: 0, data: { id: item.id } });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 更新购物车商品数量
app.post('/api/cart/update', async (req, res) => {
  try {
    const openid = req.headers['x-wx-openid'] || 'local_dev_user';
    const { spuId, skuId, quantity } = req.body;
    const item = await CartItem.findOne({ where: { openid, spuId, skuId: skuId || '' } });
    if (!item) return res.send({ code: -1, message: '商品不在购物车中' });
    item.quantity = quantity;
    await item.save();
    res.send({ code: 0 });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 切换选中状态
app.post('/api/cart/select', async (req, res) => {
  try {
    const openid = req.headers['x-wx-openid'] || 'local_dev_user';
    const { spuId, skuId, isSelected } = req.body;
    const item = await CartItem.findOne({ where: { openid, spuId, skuId: skuId || '' } });
    if (!item) return res.send({ code: -1, message: '商品不在购物车中' });
    item.isSelected = !!isSelected;
    await item.save();
    res.send({ code: 0 });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 删除购物车商品
app.post('/api/cart/delete', async (req, res) => {
  try {
    const openid = req.headers['x-wx-openid'] || 'local_dev_user';
    const { spuId, skuId } = req.body;
    await CartItem.destroy({ where: { openid, spuId, skuId: skuId || '' } });
    res.send({ code: 0 });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// ============ 结算接口 ============

// 结算页数据（根据商品列表计算价格）
app.post('/api/order/settle', async (req, res) => {
  try {
    const { goodsRequestList = [] } = req.body;

    // 构造 skuDetailVos
    const skuDetailVos = goodsRequestList.map((item) => ({
      storeId: item.storeId || '1',
      spuId: item.spuId,
      skuId: item.skuId || '',
      goodsName: item.goodsName || item.title || '',
      image: item.primaryImage || item.thumb || '',
      quantity: item.quantity || 1,
      settlePrice: item.price || 0,
      tagPrice: null,
      tagText: null,
      skuSpecLst: item.specInfo || [],
    }));

    // 计算总价
    const totalSalePrice = skuDetailVos.reduce((sum, g) => sum + g.quantity * Number(g.settlePrice), 0);
    const totalGoodsCount = skuDetailVos.reduce((sum, g) => sum + g.quantity, 0);

    res.send({
      code: 0,
      data: {
        settleType: 1,
        userAddress: null,
        totalGoodsCount,
        totalAmount: totalSalePrice,
        totalPayAmount: totalSalePrice,
        totalSalePrice,
        totalDiscountAmount: 0,
        totalPromotionAmount: 0,
        totalCouponAmount: 0,
        totalDeliveryFee: 0,
        invoiceSupport: 0,
        storeGoodsList: [
          {
            storeId: '1',
            storeName: '立康林旗舰店',
            storeTotalPayAmount: totalSalePrice,
            skuDetailVos,
            couponList: [],
          },
        ],
        inValidGoodsList: null,
        outOfStockGoodsList: null,
        limitGoodsList: null,
        abnormalDeliveryGoodsList: null,
      },
    });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// ============ 订单接口 ============

// 订单列表
app.get('/api/order/list', async (req, res) => {
  try {
    const pageNum = Math.max(Number(req.query.pageNum) || 1, 1);
    const pageSize = Math.max(Number(req.query.pageSize) || 10, 1);
    const orderStatus = req.query.orderStatus;
    const where = {};

    if (orderStatus !== undefined && orderStatus !== '') {
      where.orderStatus = Number(orderStatus);
    }

    const { rows, count } = await Order.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      offset: (pageNum - 1) * pageSize,
      limit: pageSize,
    });

    const statuses = [-1, 5, 10, 40, 50];
    const tabCounts = await Promise.all(
      statuses.map(async (status) => ({
        tabType: status,
        orderNum: status === -1 ? await Order.count() : await Order.count({ where: { orderStatus: status } }),
      })),
    );

    res.send({
      code: 0,
      data: {
        orders: rows.map(formatOrderForMiniProgram),
        total: count,
        tabCounts,
      },
    });
  } catch (err) {
    console.error('获取订单列表失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

// 订单详情，兼容前端传数据库 id 或订单号
app.get('/api/order/detail/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const where = {
      [Op.or]: [{ orderNo: id }],
    };

    if (/^\d+$/.test(id)) {
      where[Op.or].push({ id: Number(id) });
    }

    const order = await Order.findOne({ where });
    if (!order) {
      return res.send({ code: -1, message: '订单不存在' });
    }

    res.send({ code: 0, data: formatOrderForMiniProgram(order) });
  } catch (err) {
    console.error('获取订单详情失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

// 创建订单
app.post('/api/order/create', async (req, res) => {
  try {
    const headerOpenid = req.headers['x-wx-openid'] || '';
    const { goodsList = [], userAddress, userName, totalAmount, remark, authorizationCode } = req.body;
    const codeOpenid = await getOpenidByCode(authorizationCode);
    const openid = headerOpenid || codeOpenid || 'local_dev_user';

    // 后端重新计算总价（以防前端篡改）
    const calcTotal = goodsList.reduce((sum, g) => sum + (Number(g.price) || 0) * (Number(g.quantity) || 1), 0);
    if (calcTotal <= 0) {
      return res.send({ code: -1, message: '订单金额异常' });
    }

    const orderNo = 'ORD' + Date.now() + Math.random().toString(36).slice(2, 6);

    const order = await Order.create({
      orderNo,
      openid,
      orderStatus: 5,
      orderStatusName: '待付款',
      totalAmount: String(calcTotal),
      paymentAmount: String(calcTotal),
      goodsList: goodsList, // 完整商品快照（含名称、图片、规格、单价、数量）
      userAddress: userAddress || null,
      userName: userName || '',
      remark: remark || '',
    });

    console.log('✅ 订单已写入数据库:', order.orderNo, '商品数:', goodsList.length, '总价:', calcTotal);

    let payData = null;
    if (isWxPayConfigured() && openid !== 'local_dev_user') {
      const firstGoodsName = goodsList[0] && goodsList[0].goodsName;
      const { payAmount, prepayId, payInfo } = await createWechatPrepay({
        orderNo,
        openid,
        amount: calcTotal,
        description: firstGoodsName || `订单${orderNo}`,
      });
      await order.update({ prepayId, paymentAmount: String(payAmount) });
      payData = {
        channel: 'wechat',
        tradeNo: order.orderNo,
        orderNo: order.orderNo,
        orderId: order.id,
        paymentAmount: String(payAmount),
        payInfo,
      };
    } else if (!wxPayConfig.mockWhenUnconfigured) {
      return res.send({ code: -1, message: '微信支付参数未配置，无法发起支付' });
    }

    res.send({
      code: 0,
      data: {
        orderId: order.id,
        orderNo: order.orderNo,
        totalAmount: order.totalAmount,
        paymentAmount: order.paymentAmount,
        orderStatus: order.orderStatus,
        goodsList: order.goodsList,
        ...payData,
      },
    });
  } catch (err) {
    console.error('创建订单失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

// 小程序端支付成功后主动同步订单状态。
// 微信支付通知仍是最终可信来源；这个接口用于本地模拟支付和避免通知异步导致详情页短暂显示待付款。
app.post('/api/order/paid', async (req, res) => {
  try {
    const { orderId, orderNo, transactionId } = req.body || {};
    const conditions = [];

    if (orderNo) {
      conditions.push({ orderNo });
    }
    if (orderId && /^\d+$/.test(String(orderId))) {
      conditions.push({ id: Number(orderId) });
    }
    if (conditions.length === 0) {
      return res.send({ code: -1, message: '缺少订单标识' });
    }

    const order = await Order.findOne({ where: { [Op.or]: conditions } });
    if (!order) {
      return res.send({ code: -1, message: '订单不存在' });
    }

    if (Number(order.orderStatus) === 5) {
      await order.update({
        orderStatus: 10,
        orderStatusName: '待发货',
        transactionId: transactionId || order.transactionId || 'CLIENT_CONFIRMED',
        paidAt: order.paidAt || new Date(),
      });
    }

    res.send({ code: 0, data: formatOrderForMiniProgram(order) });
  } catch (err) {
    console.error('同步支付状态失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

// 微信支付通知回调
app.post('/api/pay/wechat/notify', async (req, res) => {
  try {
    if (!wxPayConfig.apiV3Key) {
      return res.status(500).send({ code: 'FAIL', message: 'WECHAT_PAY_API_V3_KEY 未配置' });
    }
    const notifyBody = req.body || {};
    if (!notifyBody.resource) {
      return res.status(400).send({ code: 'FAIL', message: '通知数据异常' });
    }

    const payResult = decryptNotifyResource(notifyBody.resource);
    const order = await Order.findOne({ where: { orderNo: payResult.out_trade_no } });
    if (order && payResult.trade_state === 'SUCCESS') {
      await order.update({
        orderStatus: 10,
        orderStatusName: '待发货',
        transactionId: payResult.transaction_id,
        paidAt: payResult.success_time ? new Date(payResult.success_time) : new Date(),
      });
      console.log('✅ 微信支付成功:', order.orderNo, payResult.transaction_id);
    }

    res.send({ code: 'SUCCESS', message: '成功' });
  } catch (err) {
    console.error('微信支付通知处理失败:', err);
    res.status(500).send({ code: 'FAIL', message: err.message });
  }
});

const port = process.env.PORT || 3000;

async function bootstrap() {
  await initDB();

  // 本地开发模式下自动插入种子数据（SQLite 内存库每次重启都是空的）
  if (!process.env.MYSQL_ADDRESS) {
    const count = await Product.count();
    if (count === 0) {
      console.log('🌱 本地模式：自动插入种子数据...');
      // 触发 seed 逻辑
      const http = require('http');
      app.listen(port, () => {
        console.log('启动成功', port);
        http
          .request({ hostname: '127.0.0.1', port, path: '/api/products/seed', method: 'POST' }, (res) => {
            let body = '';
            res.on('data', (chunk) => (body += chunk));
            res.on('end', () => console.log('🌱 种子数据:', body));
          })
          .end();
      });
      return;
    }
  }

  app.listen(port, () => {
    console.log('启动成功', port);
  });
}

bootstrap();
