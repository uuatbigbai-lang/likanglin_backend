const path = require('path');
const https = require('https');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { Op } = require('sequelize');
const {
  init: initDB,
  Counter,
  User,
  Product,
  Address,
  CartItem,
  Order,
  AfterSale,
  AdminWhitelist,
  CouponTemplate,
  CouponRecord,
  Sample,
  HomeAsset,
  HomeBanner,
} = require('./db');
const { withCloudHomeAssetPicture, withCloudHomeBannerPicture, withCloudProductPictures } = require('./productPictures');
const {
  wxPayConfig,
  isWxPayConfigured,
  createWechatPrepay,
  createWechatRefund,
  getOpenidByCode,
  decryptNotifyResource,
} = require('./wxPay');

const logger = morgan('tiny');

const HOME_ASSET_DEFINITIONS = [
  { key: 'logo', label: '首页品牌 Logo' },
  { key: 'icon1', label: '肠道检测' },
  { key: 'icon2', label: '报告截图' },
  { key: 'icon3', label: '益生菌方案' },
  { key: 'icon4', label: '科普知识' },
  { key: 'nutritionPlaceholder', label: '首页占位图' },
];

const HOME_ASSET_KEYS = new Set(HOME_ASSET_DEFINITIONS.map((item) => item.key));
const ASSET_KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{1,63}$/;

const formatHomeAsset = (asset) => {
  const data = withCloudHomeAssetPicture(asset);
  return {
    key: data.assetKey,
    label: data.label || '',
    url: data.url || '',
    updatedAt: data.updatedAt,
  };
};

const formatHomeBanner = (banner) => {
  const data = withCloudHomeBannerPicture(banner);
  return {
    id: data.id,
    title: data.title || '',
    imageUrl: data.imageUrl || '',
    linkType: data.linkType || 'none',
    linkValue: data.linkValue || '',
    sort: data.sort || 0,
    status: data.status,
    updatedAt: data.updatedAt,
  };
};

const validateAssetKey = (assetKey) => ASSET_KEY_PATTERN.test(assetKey) && (HOME_ASSET_KEYS.has(assetKey) || assetKey.startsWith('custom_'));

const DEFAULT_USER_AVATAR =
  'https://tdesign.gtimg.com/miniprogram/template/retail/usercenter/icon-user-center-avatar@2x.png';

const ORDER_STATUS_RETURNING = 60;
const ORDER_STATUS_REFUNDED = 70;

const DEFAULT_COUPON_TEMPLATES = [
  {
    templateType: 'nine',
    title: '9折券',
    ruleType: 'discount',
    value: 9,
    thresholdAmount: 0,
    minQuantity: 0,
    desc: '订单商品金额可享9折优惠',
    sort: 30,
  },
  {
    templateType: 'seven',
    title: '7折券',
    ruleType: 'discount',
    value: 7,
    thresholdAmount: 0,
    minQuantity: 0,
    desc: '订单商品金额可享7折优惠',
    sort: 20,
  },
  {
    templateType: 'buy2get1',
    title: '买二送一券',
    ruleType: 'buy_x_get_y',
    value: 1,
    thresholdAmount: 0,
    minQuantity: 3,
    desc: '同一订单购买满3件，免除最低价1件商品金额',
    sort: 10,
  },
];

const normalizeCouponTemplate = (template = {}) => {
  const ruleType = String(template.ruleType || template.type || 'discount').trim();
  const value = Math.max(Number(template.value || 0), 0);
  const thresholdAmount = Math.max(Number(template.thresholdAmount || template.base || 0), 0);
  const minQuantity =
    Math.max(Number(template.minQuantity || (ruleType === 'buy_x_get_y' ? 3 : 0)), 0);
  const desc = String(template.desc || '').trim() || (
    ruleType === 'discount'
      ? `订单商品金额可享${value}折优惠`
      : ruleType === 'amount'
        ? `订单可减免${(value / 100).toFixed(2)}元`
        : `订单满${minQuantity}件，免除最低价${value || 1}件商品金额`
  );

  return {
    templateType: String(template.templateType || '').trim(),
    title: String(template.title || '优惠券').trim(),
    ruleType,
    value,
    thresholdAmount,
    minQuantity,
    desc,
    status: Number(template.status ?? 1),
    sort: Number(template.sort || 0),
    meta: template.meta || {},
  };
};

const getCouponTemplateSnapshot = (coupon = {}) => {
  const data = typeof coupon.toJSON === 'function' ? coupon.toJSON() : coupon;
  const snapshot = data.meta && Object.keys(data.meta).length ? data.meta : null;
  if (snapshot) return normalizeCouponTemplate({ ...snapshot, templateType: data.templateType, title: data.title || snapshot.title });
  const fallback = DEFAULT_COUPON_TEMPLATES.find((item) => item.templateType === data.templateType) || {};
  return normalizeCouponTemplate({ ...fallback, templateType: data.templateType, title: data.title || fallback.title });
};

const formatCouponTemplate = (template) => normalizeCouponTemplate(
  typeof template?.toJSON === 'function' ? template.toJSON() : template,
);

const ensureDefaultCouponTemplates = async () => {
  for (const template of DEFAULT_COUPON_TEMPLATES) {
    const normalized = normalizeCouponTemplate(template);
    const existed = await CouponTemplate.findOne({ where: { templateType: normalized.templateType } });
    if (!existed) {
      await CouponTemplate.create(normalized);
    }
  }
};

const getActiveCouponTemplate = async (templateType) => {
  const template = await CouponTemplate.findOne({
    where: { templateType: String(templateType || '').trim(), status: 1 },
  });
  return template ? formatCouponTemplate(template) : null;
};

const buildCouponNo = () => `CP${Date.now()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

const isCouponAdmin = async (openid) => {
  if (!openid) return false;
  const count = await AdminWhitelist.count({ where: { openid } });
  return count > 0;
};

const formatCouponRecord = (coupon) => {
  if (!coupon) return null;
  const data = typeof coupon.toJSON === 'function' ? coupon.toJSON() : coupon;
  const template = getCouponTemplateSnapshot(data);
  const statusMap = {
    generated: 'default',
    claimed: 'default',
    used: 'useless',
    expired: 'disabled',
  };
  const statusTextMap = {
    generated: '待认领',
    claimed: '待使用',
    used: '已核销',
    expired: '已作废',
  };
  return {
    key: data.couponNo,
    couponNo: data.couponNo,
    status: statusMap[data.status] || 'disabled',
    recordStatus: data.status,
    type: template.ruleType === 'buy_x_get_y' ? 4 : template.ruleType === 'amount' ? 1 : 2,
    value: template.value || 0,
    tag: statusTextMap[data.status] || '已失效',
    statusText: statusTextMap[data.status] || '已失效',
    canVoid: ['generated', 'claimed'].includes(data.status),
    desc: template.desc || '',
    title: data.title || template.title || '优惠券',
    timeLimit: '长期有效',
    currency: template.ruleType === 'discount' ? '' : '¥',
    createdByOpenid: data.createdByOpenid || '',
    claimedByOpenid: data.claimedByOpenid || '',
    usedByOpenid: data.usedByOpenid || '',
    orderNo: data.orderNo || '',
    discountAmount: data.discountAmount || '0',
    createdAt: data.createdAt,
    claimedAt: data.claimedAt,
    usedAt: data.usedAt,
    useNotes: template.ruleType === 'buy_x_get_y'
      ? `订单商品总数满${template.minQuantity || 3}件时自动抵扣最低价${template.value || 1}件。`
      : '下单时自动选择可用优惠券并抵扣。',
    storeAdapt: '商城通用',
  };
};

const calculateCouponDiscount = (coupon, goodsList = [], totalAmount = 0) => {
  if (!coupon || coupon.status !== 'claimed') return 0;
  const amount = Math.max(Number(totalAmount || 0), 0);
  if (amount <= 0) return 0;
  const template = getCouponTemplateSnapshot(coupon);
  if (template.thresholdAmount && amount < template.thresholdAmount) return 0;

  if (template.ruleType === 'discount') {
    if (template.value <= 0 || template.value >= 10) return 0;
    return Math.floor(amount * (10 - template.value) / 10);
  }
  if (template.ruleType === 'amount') {
    return Math.min(Math.max(Number(template.value || 0), 0), Math.max(amount - 1, 0));
  }
  if (template.ruleType === 'buy_x_get_y') {
    const units = [];
    goodsList.forEach((goods) => {
      const qty = Math.max(Number(goods.quantity || goods.buyQuantity || 1), 0);
      const price = Math.max(Number(goods.price || goods.settlePrice || goods.actualPrice || 0), 0);
      for (let index = 0; index < qty; index += 1) units.push(price);
    });
    const minQuantity = Math.max(Number(template.minQuantity || 3), 1);
    const freeQuantity = Math.max(Number(template.value || 1), 1);
    if (units.length < minQuantity) return 0;
    return units
      .sort((left, right) => left - right)
      .slice(0, freeQuantity)
      .reduce((sum, price) => sum + price, 0);
  }
  return 0;
};

const getCouponUnavailableReason = (coupon, goodsList = []) => {
  if (!coupon) return '优惠券不可用';
  const template = getCouponTemplateSnapshot(coupon);
  if (template.ruleType === 'buy_x_get_y') {
    const totalQuantity = goodsList.reduce((sum, goods) => sum + Math.max(Number(goods.quantity || goods.buyQuantity || 1), 0), 0);
    if (totalQuantity < (template.minQuantity || 3)) return `${template.title}需当前订单满${template.minQuantity || 3}件商品可用`;
  }
  if (template.thresholdAmount) {
    return `${template.title}需订单满${(template.thresholdAmount / 100).toFixed(2)}元可用`;
  }
  return '当前订单暂不满足使用条件';
};

const buildDefaultNickName = (openid = '') => {
  const suffix = String(openid || 'guest')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(-4)
    .toUpperCase() || 'GUEST';
  return `小林${suffix}`;
};

const formatUserInfo = (user) => {
  const data = user && typeof user.toJSON === 'function' ? user.toJSON() : { ...user };
  return {
    openid: data.openid,
    nickName: data.nickName,
    avatarUrl: data.avatarUrl || DEFAULT_USER_AVATAR,
    phoneNumber: data.phoneNumber || '',
    gender: data.gender || 0,
  };
};

const saveHomeAsset = async (req, res) => {
  try {
    const assetKey = String(req.params.key || '').trim();
    if (!validateAssetKey(assetKey)) {
      return res.send({ code: -1, message: '无效的资源 key' });
    }

    const { label, url, fileName, imageUrl } = req.body || {};
    const assetFile = String(fileName || imageUrl || url || '').trim();
    const preset = HOME_ASSET_DEFINITIONS.find((item) => item.key === assetKey);
    if (!assetFile) {
      return res.send({ code: -1, message: '请提供 url、imageUrl 或 fileName' });
    }

    await HomeAsset.upsert({
      assetKey,
      label: String(label || preset?.label || assetKey).trim(),
      url: assetFile,
    });
    const saved = await HomeAsset.findOne({ where: { assetKey } });
    res.send({ code: 0, data: formatHomeAsset(saved) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
};

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
  if (Number(orderStatus) === 40) {
    return [{ primary: true, type: 3, name: '确认收货' }];
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

const isWechatPayTransactionId = (value) => /^420\d{25,}$/.test(String(value || '').trim());

const buildLogisticsVO = (address = {}, order = {}) => {
  const receiverAddress = address.detailAddress || address.address || '';
  return {
    logisticsType: 1,
    logisticsNo: order.logisticsNo || '',
    logisticsStatus: null,
    logisticsCompanyCode: order.logisticsCompanyCode || '',
    logisticsCompanyName: order.logisticsCompanyName || '',
    waybillToken: order.waybillToken || '',
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

const formatOrderForMiniProgram = (order, afterSales = []) => {
  const data = typeof order.toJSON === 'function' ? order.toJSON() : order;
  const goodsList = Array.isArray(data.goodsList) ? data.goodsList : [];
  const normalizedAfterSales = (afterSales || []).map((item) => (
    typeof item.toJSON === 'function' ? item.toJSON() : item
  ));
  const activeAfterSales = normalizedAfterSales.filter((item) => Number(item.rightsStatus) !== AFTER_SERVICE_STATUS.CLOSED);
  const hasActiveAfterSale = activeAfterSales.length > 0;
  const latestAfterSale = activeAfterSales[0] || null;
  const createTime = new Date(data.createdAt || Date.now()).getTime();
  const paySuccessTime = data.paidAt ? new Date(data.paidAt).getTime() : null;
  const latestAfterSaleStatus = Number(latestAfterSale?.rightsStatus);
  const orderStatusNameMap = {
    5: '待付款',
    10: '待发货',
    40: '待收货',
    50: '交易完成',
    [ORDER_STATUS_RETURNING]: '退货中',
    [ORDER_STATUS_REFUNDED]: '已退款',
  };
  const displayStatusName = hasActiveAfterSale
    ? (
        latestAfterSaleStatus === AFTER_SERVICE_STATUS.COMPLETE
          ? '售后已完成'
          : Number(latestAfterSale.rightsType) === 10 ? '退货退款中' : '退款处理中'
      )
    : data.orderStatusName || orderStatusNameMap[Number(data.orderStatus)] || '待付款';
  const sampleStatusNameMap = {
    returning: '回寄中',
    testing: '样本检测中',
    completed: '检测完成',
  };

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
    discountAmount: String(data.couponAmount || '0'),
    channelType: 0,
    channelSource: '',
    channelIdentity: '',
    remark: data.remark || '',
    cancelType: 0,
    cancelReasonType: 0,
    cancelReason: '',
    rightsType: latestAfterSale ? latestAfterSale.rightsType : 0,
    rightsNo: latestAfterSale ? latestAfterSale.rightsNo : '',
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
        buttonVOs: !hasActiveAfterSale && Number(data.orderStatus) === 50
          ? [{ primary: false, type: 4, name: '申请售后' }]
          : [],
      };
    }),
    logisticsVO: buildLogisticsVO(data.userAddress || {}, data),
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
    waybillToken: data.waybillToken || '',
    waybill_token: data.waybillToken || '',
    sampleStatus: data.sampleStatus || '',
    sampleStatusName: sampleStatusNameMap[data.sampleStatus] || data.sampleStatus || '',
    buttonVOs: hasActiveAfterSale ? [{ primary: false, type: 5, name: '查看售后' }] : getOrderButtons(data.orderStatus),
    labelVOs: null,
    invoiceVO: null,
    couponAmount: String(data.couponAmount || '0'),
    couponNo: data.couponNo || '',
    couponSnapshot: data.couponSnapshot || null,
    autoCancelTime: createTime + 30 * 60 * 1000,
    orderStatusName: displayStatusName,
    orderStatusRemark:
      Number(data.orderStatus) === 5
        ? `需支付￥${(Number(data.paymentAmount || data.totalAmount || 0) / 100).toFixed(2)}`
        : displayStatusName,
    logisticsLogVO: null,
    trajectoryVos: data.trajectoryVos || [],
    invoiceStatus: 3,
    invoiceDesc: '暂不开发票',
    invoiceUrl: null,
  };
};

const RETURN_ADDRESS = {
  name: process.env.RETURN_RECEIVER_NAME || '售后仓库',
  mobile: process.env.RETURN_RECEIVER_MOBILE || '13800000000',
  tel: process.env.RETURN_RECEIVER_TEL || '',
  company: process.env.RETURN_RECEIVER_COMPANY || '官方商城',
  post_code: process.env.RETURN_RECEIVER_POST_CODE || '000000',
  country: process.env.RETURN_RECEIVER_COUNTRY || '中国',
  province: process.env.RETURN_RECEIVER_PROVINCE || '广东省',
  city: process.env.RETURN_RECEIVER_CITY || '深圳市',
  area: process.env.RETURN_RECEIVER_AREA || '南山区',
  address: process.env.RETURN_RECEIVER_ADDRESS || '前海路333号售后仓',
};

let wechatAccessTokenCache = {
  token: '',
  expiresAt: 0,
};

const requestWechatJson = ({ method = 'GET', path: urlPath, data }) =>
  new Promise((resolve, reject) => {
    const bodyText = data ? JSON.stringify(data) : '';
    const req = https.request(
      {
        hostname: 'api.weixin.qq.com',
        path: urlPath,
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyText),
        },
      },
      (response) => {
        let responseText = '';
        response.on('data', (chunk) => {
          responseText += chunk;
        });
        response.on('end', () => {
          let json = {};
          try {
            json = responseText ? JSON.parse(responseText) : {};
          } catch (err) {
            return reject(new Error('微信接口返回解析失败'));
          }
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(json.errmsg || `微信接口请求失败：${response.statusCode}`));
          }
        });
      },
    );
    req.on('error', reject);
    if (bodyText) req.write(bodyText);
    req.end();
  });

const getWechatAccessToken = async () => {
  if (wechatAccessTokenCache.token && Date.now() < wechatAccessTokenCache.expiresAt) {
    return wechatAccessTokenCache.token;
  }
  if (!wxPayConfig.appId || !wxPayConfig.appSecret) return '';

  const tokenRes = await requestWechatJson({
    path:
      `/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(wxPayConfig.appId)}` +
      `&secret=${encodeURIComponent(wxPayConfig.appSecret)}`,
  });
  if (tokenRes.errcode) {
    throw new Error(tokenRes.errmsg || `获取 access_token 失败：${tokenRes.errcode}`);
  }

  wechatAccessTokenCache = {
    token: tokenRes.access_token || '',
    expiresAt: Date.now() + Math.max(Number(tokenRes.expires_in || 7200) - 300, 60) * 1000,
  };
  return wechatAccessTokenCache.token;
};

const normalizeReturnAddress = (address = {}) => ({
  name: address.name || '',
  mobile: address.mobile || address.phone || address.phoneNumber || '',
  country: address.country || '中国',
  province: address.province || address.provinceName || '',
  city: address.city || address.cityName || '',
  area: address.area || address.areaName || address.districtName || '',
  address: address.address || address.detailAddress || '',
});

const buildWechatReturnPayload = ({ afterSale, order }) => {
  const orderData = typeof order.toJSON === 'function' ? order.toJSON() : order;
  const goods = Array.isArray(afterSale.rightsItems) ? afterSale.rightsItems : [];

  return {
    shop_order_id: afterSale.rightsNo,
    biz_addr: normalizeReturnAddress(RETURN_ADDRESS),
    user_addr: normalizeReturnAddress(orderData.userAddress || {}),
    openid: afterSale.openid || orderData.openid || '',
    order_path: `/pages/order/after-service-detail/index?rightsNo=${afterSale.rightsNo}`,
    goods_list: goods.map((item) => ({
      name: item.goodsName || '退货商品',
      url: item.goodsPictureUrl || '',
    })),
    order_price: Number(afterSale.refundRequestAmount || 0),
  };
};

const createWechatReturnId = async ({ afterSale, order }) => {
  if (!afterSale || !order) return '';
  if (!afterSale.openid || afterSale.openid === 'local_dev_user') return '';

  const accessToken = await getWechatAccessToken();
  if (!accessToken) return '';

  const result = await requestWechatJson({
    method: 'POST',
    path: `/cgi-bin/express/delivery/return/add?access_token=${encodeURIComponent(accessToken)}`,
    data: buildWechatReturnPayload({ afterSale, order }),
  });
  if (result.errcode) {
    throw new Error(result.errmsg || `创建微信退货 ID 失败：${result.errcode}`);
  }
  return result.return_id || '';
};

const WX_TEST_DELIVERY_ID = 'TEST';
const WX_TEST_BIZ_ID = 'test_biz_id';

const LOGISTICS_ACTION_CONFIG = {
  100001: {
    code: '100001',
    title: '已揽收',
    status: '快递员已揽收',
    orderStatus: 40,
    orderStatusName: '待收货',
  },
  200001: {
    code: '200001',
    title: '运输中',
    status: '包裹正在运输中',
    orderStatus: 40,
    orderStatusName: '待收货',
  },
  200003: {
    code: '200003',
    title: '已发货',
    status: '商家已发货',
    orderStatus: 40,
    orderStatusName: '待收货',
  },
  300003: {
    code: '300003',
    title: '签收成功',
    status: '包裹已签收成功',
    orderStatus: 50,
    orderStatusName: '交易完成',
  },
};

const getLogisticsActionConfig = (actionType) =>
  LOGISTICS_ACTION_CONFIG[Number(actionType)] || {
    code: String(actionType || '200001'),
    title: '物流更新',
    status: `物流状态已更新：${actionType}`,
    orderStatus: 40,
    orderStatusName: '待收货',
  };

const getLogisticsActionMsg = (actionType) => getLogisticsActionConfig(actionType).status;

const mergeTrajectory = (trajectoryVos = [], actionType, eventTime = Date.now()) => {
  const config = getLogisticsActionConfig(actionType);
  const node = {
    status: config.status,
    timestamp: String(eventTime),
    remark: null,
  };
  const next = Array.isArray(trajectoryVos) ? [...trajectoryVos] : [];
  const existed = next.find((item) => String(item.code) === String(config.code));

  if (existed) {
    existed.title = config.title;
    existed.nodes = [node, ...((existed.nodes || []).filter((item) => item.status !== node.status))];
    return next;
  }

  return [
    {
      title: config.title,
      icon: 'deliver',
      code: config.code,
      nodes: [node],
    },
    ...next,
  ];
};

const readAutoCheckDays = () => {
  const raw = process.env.AUTO_CHECK;
  if (raw === undefined || raw === '') return 14;
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) return 0;
  return days;
};

const getShippedAt = (order) => {
  const data = typeof order.toJSON === 'function' ? order.toJSON() : order;
  const trajectoryVos = Array.isArray(data.trajectoryVos) ? data.trajectoryVos : [];
  const shipped = trajectoryVos.find((item) => String(item.code) === '200003');
  const shippedTimestamp = shipped && shipped.nodes && shipped.nodes[0] && Number(shipped.nodes[0].timestamp);
  if (Number.isFinite(shippedTimestamp) && shippedTimestamp > 0) return shippedTimestamp;
  return new Date(data.updatedAt || data.createdAt || Date.now()).getTime();
};

const autoConfirmReceivedOrders = async () => {
  const days = readAutoCheckDays();
  if (!days) {
    console.log('⏱️ AUTO_CHECK 未启用，跳过自动确认收货');
    return { checked: 0, confirmed: 0, skipped: true };
  }

  const deadline = Date.now() - days * 24 * 60 * 60 * 1000;
  const orders = await Order.findAll({ where: { orderStatus: 40 } });
  let confirmed = 0;

  for (const order of orders) {
    const shippedAt = getShippedAt(order);
    if (shippedAt > deadline) continue;

    const activeAfterSaleCount = await AfterSale.count({
      where: {
        orderNo: order.orderNo,
        rightsStatus: { [Op.ne]: AFTER_SERVICE_STATUS.CLOSED },
      },
    });
    if (activeAfterSaleCount > 0) continue;

    await order.update({
      orderStatus: 50,
      orderStatusName: '交易完成',
      trajectoryVos: mergeTrajectory(order.trajectoryVos || [], 300003),
    });
    confirmed += 1;
    console.log(`✅ 自动确认收货: ${order.orderNo}，发货已超过 ${days} 天`);
  }

  return { checked: orders.length, confirmed, days };
};

const startAutoConfirmReceivedTask = () => {
  const days = readAutoCheckDays();
  if (!days) {
    console.log('⏱️ 自动确认收货已关闭：AUTO_CHECK <= 0');
    return;
  }

  const intervalMs = Math.max(Number(process.env.AUTO_CHECK_INTERVAL_MS) || 6 * 60 * 60 * 1000, 60 * 1000);
  const run = () => {
    autoConfirmReceivedOrders().catch((err) => {
      console.error('自动确认收货任务失败:', err);
    });
  };

  console.log(`⏱️ 自动确认收货已启用：发货超过 ${days} 天后确认，每 ${Math.round(intervalMs / 60000)} 分钟检查一次`);
  run();
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
};

const testUpdateWechatLogisticsOrder = async ({ orderNo, waybillId, actionType }) => {
  const accessToken = await getWechatAccessToken();
  if (!accessToken) {
    return { skipped: true, errmsg: '未配置 WECHAT_APP_ID/WECHAT_APP_SECRET，已跳过微信测试接口调用' };
  }

  return requestWechatJson({
    method: 'POST',
    path: `/cgi-bin/express/business/test_update_order?access_token=${encodeURIComponent(accessToken)}`,
    data: {
      biz_id: WX_TEST_BIZ_ID,
      order_id: orderNo,
      delivery_id: WX_TEST_DELIVERY_ID,
      waybill_id: waybillId,
      action_time: Math.floor(Date.now() / 1000),
      action_type: Number(actionType),
      action_msg: getLogisticsActionMsg(actionType),
    },
  });
};

const formatWechatUploadTime = (date = new Date()) => {
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  const local = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `.${pad(local.getUTCMilliseconds(), 3)}+08:00`;
};

const buildWechatShippingPayload = ({ order, trackingNo, expressCompany, itemDesc, receiverContact }) => {
  const data = typeof order.toJSON === 'function' ? order.toJSON() : order;
  const goodsList = Array.isArray(data.goodsList) ? data.goodsList : [];
  const userAddress = data.userAddress || {};
  const description =
    itemDesc ||
    goodsList
      .map((goods) => goods.goodsName || goods.title)
      .filter(Boolean)
      .join('、')
      .slice(0, 120) ||
    `订单${data.orderNo}`;

  const orderKey = isWechatPayTransactionId(data.transactionId)
    ? {
        order_number_type: 2,
        transaction_id: data.transactionId,
      }
    : {
        order_number_type: 1,
        mchid: wxPayConfig.mchId,
        out_trade_no: data.orderNo,
      };

  return {
    order_key: orderKey,
    logistics_type: 1,
    delivery_mode: 1,
    is_all_delivered: true,
    shipping_list: [
      {
        tracking_no: trackingNo,
        express_company: expressCompany,
        item_desc: description,
        contact: {
          receiver_contact: receiverContact || userAddress.phone || userAddress.phoneNumber || '',
        },
      },
    ],
    upload_time: formatWechatUploadTime(),
    payer: {
      openid: data.openid || '',
    },
  };
};

const getWechatPublicBaseUrl = () => {
  const explicit = process.env.PUBLIC_BASE_URL || process.env.WECHAT_PUBLIC_BASE_URL || process.env.BASE_URL || '';
  if (explicit) return explicit.replace(/\/$/, '');
  if (wxPayConfig.notifyUrl) {
    try {
      const url = new URL(wxPayConfig.notifyUrl);
      return `${url.protocol}//${url.host}`;
    } catch (err) {
      return '';
    }
  }
  return '';
};

const WECHAT_ORDER_NOTIFY_URL =
  process.env.WECHAT_ORDER_NOTIFY_URL ||
  (getWechatPublicBaseUrl() ? `${getWechatPublicBaseUrl()}/api/order/wechat/notify` : '');

const WECHAT_ORDER_MSG_JUMP_PATH =
  process.env.WECHAT_ORDER_MSG_JUMP_PATH ||
  'pages/order/order-detail/index?id=${商品订单号}&channel=wechat';

const setWechatOrderMsgJumpPath = async (path = WECHAT_ORDER_MSG_JUMP_PATH) => {
  const accessToken = await getWechatAccessToken();
  if (!accessToken) {
    throw new Error('未配置 WECHAT_APP_ID/WECHAT_APP_SECRET，无法设置微信订单消息跳转路径');
  }

  const result = await requestWechatJson({
    method: 'POST',
    path: `/wxa/sec/order/set_msg_jump_path?access_token=${encodeURIComponent(accessToken)}`,
    data: { path },
  });

  if (result.errcode) {
    throw new Error(result.errmsg || `微信订单消息跳转路径设置失败：${result.errcode}`);
  }

  return result;
};

const uploadWechatShippingInfo = async (payload) => {
  const accessToken = await getWechatAccessToken();
  if (!accessToken) {
    throw new Error('未配置 WECHAT_APP_ID/WECHAT_APP_SECRET，无法同步微信发货');
  }

  const result = await requestWechatJson({
    method: 'POST',
    path: `/wxa/sec/order/upload_shipping_info?access_token=${encodeURIComponent(accessToken)}`,
    data: payload,
  });

  if (result.errcode) {
    const error = new Error(result.errmsg || `微信发货信息录入失败：${result.errcode}`);
    error.wechatResult = result;
    throw error;
  }

  return result;
};

const buildWechatOrderQueryPayload = (order) => {
  const data = typeof order.toJSON === 'function' ? order.toJSON() : order;
  if (data.transactionId) {
    return { transaction_id: data.transactionId };
  }

  return {
    merchant_id: wxPayConfig.mchId,
    merchant_trade_no: data.orderNo,
  };
};

const getWechatOrder = async (order) => {
  const accessToken = await getWechatAccessToken();
  if (!accessToken) {
    throw new Error('未配置 WECHAT_APP_ID/WECHAT_APP_SECRET，无法查询微信订单状态');
  }

  const result = await requestWechatJson({
    method: 'POST',
    path: `/wxa/sec/order/get_order?access_token=${encodeURIComponent(accessToken)}`,
    data: buildWechatOrderQueryPayload(order),
  });

  if (result.errcode) {
    throw new Error(result.errmsg || `微信订单状态查询失败：${result.errcode}`);
  }

  return result;
};

const getWechatOrderState = (wechatOrderResult = {}) => {
  const order = wechatOrderResult.order || wechatOrderResult;
  return Number(order.order_state || order.orderState || 0);
};

const syncOrderFromWechatOrderState = async (order, source = '主动同步') => {
  const wechatOrder = await getWechatOrder(order);
  const orderState = getWechatOrderState(wechatOrder);

  if ([3, 4].includes(orderState) && Number(order.orderStatus) !== 50) {
    await order.update({
      orderStatus: 50,
      orderStatusName: '交易完成',
      trajectoryVos: mergeTrajectory(order.trajectoryVos || [], 300003),
    });
    console.log(`✅ 微信确认收货已同步本地订单(${source}):`, order.orderNo, orderState);
  }

  return { wechatOrder, orderState };
};

const buildWechatTraceWaybillPayload = (order) => {
  const data = typeof order.toJSON === 'function' ? order.toJSON() : order;
  const address = data.userAddress || {};
  const goodsList = Array.isArray(data.goodsList) ? data.goodsList : [];

  return {
    openid: data.openid || '',
    waybill_id: data.logisticsNo || '',
    delivery_id: data.logisticsCompanyCode || '',
    receiver_phone: address.phone || address.phoneNumber || '',
    goods_info: {
      detail_list: goodsList.map((goods) => ({
        goods_name: goods.goodsName || goods.title || '商品',
        goods_img_url: goods.thumb || goods.image || goods.primaryImage || '',
      })),
    },
  };
};

const traceWechatWaybill = async (order) => {
  const payload = buildWechatTraceWaybillPayload(order);
  if (!payload.openid) throw new Error('订单缺少 openid，无法获取微信物流凭证');
  if (!payload.waybill_id) throw new Error('订单缺少物流单号，无法获取微信物流凭证');
  if (!payload.delivery_id) throw new Error('订单缺少快递公司编码，无法获取微信物流凭证');
  if (!payload.receiver_phone) throw new Error('订单缺少收件人手机号，无法获取微信物流凭证');

  const accessToken = await getWechatAccessToken();
  if (!accessToken) {
    throw new Error('未配置 WECHAT_APP_ID/WECHAT_APP_SECRET，无法获取微信物流凭证');
  }

  const result = await requestWechatJson({
    method: 'POST',
    path: `/cgi-bin/express/delivery/open_msg/trace_waybill?access_token=${encodeURIComponent(accessToken)}`,
    data: payload,
  });

  if (result.errcode) {
    throw new Error(result.errmsg || `微信物流凭证获取失败：${result.errcode}`);
  }

  return {
    payload,
    result,
    waybillToken: result.waybill_token || result.waybillToken || '',
  };
};

const SERVICE_STATUS = {
  PENDING_VERIFY: 100,
  VERIFIED: 110,
  PENDING_DELIVERY: 120,
  REFUNDED: 160,
  CLOSED: 170,
};

const AFTER_SERVICE_STATUS = {
  TO_AUDIT: 10,
  THE_APPROVED: 20,
  COMPLETE: 50,
  CLOSED: 60,
};

const fetchAfterSalesForOrder = (orderNo) => AfterSale.findAll({
  where: { orderNo },
  order: [['createdAt', 'DESC']],
});

const fetchAfterSalesForOrders = async (orderNos = []) => {
  const uniqueOrderNos = [...new Set(orderNos.filter(Boolean))];
  if (!uniqueOrderNos.length) return {};

  const afterSales = await AfterSale.findAll({
    where: { orderNo: { [Op.in]: uniqueOrderNos } },
    order: [['createdAt', 'DESC']],
  });

  return afterSales.reduce((map, item) => {
    const data = typeof item.toJSON === 'function' ? item.toJSON() : item;
    if (!map[data.orderNo]) map[data.orderNo] = [];
    map[data.orderNo].push(item);
    return map;
  }, {});
};

const formatAfterSaleForMiniProgram = (afterSale) => {
  const data = typeof afterSale.toJSON === 'function' ? afterSale.toJSON() : afterSale;
  const createTime = new Date(data.createdAt || Date.now()).getTime();
  const isReturnGoods = Number(data.rightsType) === 10;
  const logistics = data.logistics || {};
  const hasLogisticsNo = !!logistics.logisticsNo;
  const userRightsStatusName =
    Number(data.userRightsStatus) === SERVICE_STATUS.REFUNDED
      ? '已退款'
      : hasLogisticsNo
        ? '买家已寄出'
        : isReturnGoods
          ? '待买家退货'
          : '待商家处理';
  const userRightsStatusDesc =
    Number(data.userRightsStatus) === SERVICE_STATUS.REFUNDED
      ? '退款/售后已完成'
      : hasLogisticsNo
        ? '退货物流已提交，商家将尽快收货处理'
        : isReturnGoods
          ? '商家已同意退货，请使用微信退货或填写退货运单'
          : '商家将尽快确认您的退款申请';

  return {
    buttonVOs: isReturnGoods && !hasLogisticsNo
      ? [{ name: '填写运单号', primary: true, type: 3 }]
      : hasLogisticsNo
        ? [
            { name: '修改运单号', primary: false, type: 4 },
            { name: '查看物流', primary: false, type: 5 },
          ]
        : [],
    refundMethodList: [{ refundMethodAmount: Number(data.refundRequestAmount || 0), refundMethodName: '微信支付' }],
    createTime: String(createTime),
    rights: {
      createTime: String(createTime),
      orderNo: data.orderNo,
      refundAmount: Number(data.refundAmount || data.refundRequestAmount || 0),
      refundRequestAmount: Number(data.refundRequestAmount || 0),
      rightsNo: data.rightsNo,
      rightsReasonDesc: data.rightsReasonDesc,
      rightsReasonType: data.rightsReasonType,
      rightsStatus: data.rightsStatus,
      rightsStatusName: userRightsStatusName,
      rightsType: data.rightsType,
      storeName: '官方商城',
      userRightsStatus: data.userRightsStatus,
      userRightsStatusDesc,
      userRightsStatusName,
      afterSaleRequireType: isReturnGoods ? 'REFUND_GOODS_MONEY' : 'REFUND_MONEY',
      rightsImageUrls: data.rightsImageUrls || [],
      returnId: data.returnId || '',
    },
    rightsItem: data.rightsItems || [],
    rightsRefund: {
      refundDesc: data.refundMemo || '',
      refundAmount: Number(data.refundRequestAmount || 0),
      refundStatus: 1,
      traceNo: '',
    },
    logisticsVO: {
      logisticsNo: logistics.logisticsNo || '',
      logisticsCompanyName: logistics.logisticsCompanyName || '',
      logisticsCompanyCode: logistics.logisticsCompanyCode || '',
      remark: logistics.remark || '',
      receiverProvince: RETURN_ADDRESS.province,
      receiverCity: RETURN_ADDRESS.city,
      receiverCountry: RETURN_ADDRESS.area,
      receiverArea: '',
      receiverAddress: RETURN_ADDRESS.address,
      receiverPhone: RETURN_ADDRESS.mobile || RETURN_ADDRESS.tel,
      receiverName: RETURN_ADDRESS.name,
      returnId: data.returnId || '',
    },
    returnId: data.returnId || '',
  };
};

const SAMPLE_TYPE_LABELS = {
  gut: '肠道菌群检测',
  vaginal: '阴道菌群检测',
  inflammation: '肠道炎症检测',
};

const SAMPLE_LABEL_TYPES = Object.keys(SAMPLE_TYPE_LABELS).reduce((result, key) => {
  result[SAMPLE_TYPE_LABELS[key]] = key;
  return result;
}, {});

const resolveSampleType = (value = '') => {
  const text = String(value || '').trim();
  return SAMPLE_TYPE_LABELS[text] ? text : SAMPLE_LABEL_TYPES[text] || text;
};

const formatSample = (sample) => {
  const data = typeof sample.toJSON === 'function' ? sample.toJSON() : sample;
  return {
    ...data,
    _id: String(data.id),
    title: data.title || SAMPLE_TYPE_LABELS[data.type] || '信息登记',
  };
};

const normalizeSamplePayload = (body = {}) => {
  const type = resolveSampleType(body.type || body['检测类型'] || body['检测项目']);
  const extraInfo = body.extraInfo && typeof body.extraInfo === 'object' ? body.extraInfo : {};
  return {
    title: String(body.title || SAMPLE_TYPE_LABELS[type] || '信息登记').trim(),
    type,
    sampleNo: String(body.sampleNo || body['样本编号'] || '').trim(),
    name: String(body.name || body['姓名'] || '').trim(),
    age: String(body.age || body['年龄'] || '').trim(),
    gender: String(body.gender || body['性别'] || '').trim(),
    phone: String(body.phone || body['手机号'] || body['手机'] || '').trim(),
    city: String(body.city || body['城市'] || '').trim(),
    height: String(body.height || body['身高'] || '').trim(),
    weight: String(body.weight || body['体重'] || '').trim(),
    antibiotics: String(body.antibiotics || body['抗生素'] || '').trim(),
    channel: String(body.channel || body['渠道'] || '').trim(),
    remark: String(body.remark || body['备注'] || body['主诉'] || '').trim(),
    extraInfo,
  };
};

const app = express();
app.use(express.urlencoded({ extended: false, limit: '5mb' }));
app.use(express.json({
  limit: '5mb',
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
}));
app.use(cors());
app.use(logger);

const adminAuth = (req, res, next) => {
  const token = process.env.ADMIN_TOKEN || '';
  if (!token) return next();

  const requestToken = req.headers['x-admin-token'] || req.query.token || (req.body && req.body.token);
  if (requestToken === token) return next();

  return res.status(401).send({ code: -1, message: '未授权' });
};

const redeemCouponForOrder = async (order) => {
  if (!order || !order.couponNo) return null;
  const coupon = await CouponRecord.findOne({ where: { couponNo: order.couponNo } });
  if (!coupon || coupon.status === 'used') return coupon;
  if (coupon.status !== 'claimed') return coupon;

  await coupon.update({
    status: 'used',
    usedByOpenid: order.openid || coupon.claimedByOpenid,
    orderNo: order.orderNo,
    discountAmount: String(order.couponAmount || '0'),
    usedAt: new Date(),
  });
  return coupon;
};

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// 小程序调用，获取微信 Open ID
app.get('/api/wx_openid', async (req, res) => {
  if (req.headers['x-wx-source']) {
    res.send(req.headers['x-wx-openid']);
  }
});

// 自动登录：根据 openid 获取或创建用户，并为新用户分配默认昵称
app.post('/api/user/auto-login', async (req, res) => {
  try {
    const headerOpenid = req.headers['x-wx-openid'] || '';
    const { authorizationCode } = req.body || {};
    const codeOpenid = await getOpenidByCode(authorizationCode);
    const openid = headerOpenid || codeOpenid || 'local_dev_user';

    const [user, created] = await User.findOrCreate({
      where: { openid },
      defaults: {
        openid,
        nickName: buildDefaultNickName(openid),
        avatarUrl: DEFAULT_USER_AVATAR,
        phoneNumber: '',
        gender: 0,
      },
    });
    if (!created) {
      await user.update({ updatedAt: new Date() });
    }

    res.send({
      code: 0,
      data: {
        userInfo: formatUserInfo(user),
        isNewUser: created,
      },
    });
  } catch (err) {
    console.error('自动登录失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

// ============ 优惠券接口 ============

app.get('/api/coupon/admin/check', async (req, res) => {
  try {
    const openid = req.headers['x-wx-openid'] || 'local_dev_user';
    res.send({ code: 0, data: { isAdmin: await isCouponAdmin(openid), openid } });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/coupon/admin/create', async (req, res) => {
  try {
    const openid = req.headers['x-wx-openid'] || 'local_dev_user';
    if (!(await isCouponAdmin(openid))) {
      return res.send({ code: -1, message: '当前账号不是优惠券管理员' });
    }

    const template = await getActiveCouponTemplate(req.body?.templateType);
    if (!template) return res.send({ code: -1, message: '未知优惠券类型' });

    const coupon = await CouponRecord.create({
      couponNo: buildCouponNo(),
      templateType: template.templateType,
      title: template.title,
      status: 'generated',
      createdByOpenid: openid,
      meta: template,
    });

    res.send({ code: 0, data: formatCouponRecord(coupon) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.get('/api/coupon/admin/templates', async (req, res) => {
  try {
    const openid = req.headers['x-wx-openid'] || 'local_dev_user';
    if (!(await isCouponAdmin(openid))) {
      return res.send({ code: -1, message: '当前账号不是优惠券管理员' });
    }
    await ensureDefaultCouponTemplates();
    const templates = await CouponTemplate.findAll({
      where: { status: 1 },
      order: [['sort', 'DESC'], ['createdAt', 'ASC']],
    });
    res.send({ code: 0, data: templates.map(formatCouponTemplate) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.get('/api/coupon/admin/list', async (req, res) => {
  try {
    const openid = req.headers['x-wx-openid'] || 'local_dev_user';
    if (!(await isCouponAdmin(openid))) {
      return res.send({ code: -1, message: '当前账号不是优惠券管理员' });
    }

    const coupons = await CouponRecord.findAll({ order: [['createdAt', 'DESC']] });
    res.send({ code: 0, data: coupons.map(formatCouponRecord) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/coupon/admin/void', async (req, res) => {
  try {
    const openid = req.headers['x-wx-openid'] || 'local_dev_user';
    if (!(await isCouponAdmin(openid))) {
      return res.send({ code: -1, message: '当前账号不是优惠券管理员' });
    }

    const couponNo = String(req.body?.couponNo || '').trim();
    if (!couponNo) return res.send({ code: -1, message: '缺少优惠券编号' });

    const coupon = await CouponRecord.findOne({ where: { couponNo } });
    if (!coupon) return res.send({ code: -1, message: '优惠券不存在' });
    if (!['generated', 'claimed'].includes(coupon.status)) {
      return res.send({ code: -1, message: '仅待认领、待使用的优惠券可以作废' });
    }

    await coupon.update({
      status: 'expired',
      meta: {
        ...(coupon.meta || {}),
        voidedByOpenid: openid,
        voidedAt: new Date().toISOString(),
      },
    });
    res.send({ code: 0, data: formatCouponRecord(coupon) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.get('/api/coupon/detail/:couponNo', async (req, res) => {
  try {
    const coupon = await CouponRecord.findOne({ where: { couponNo: req.params.couponNo } });
    if (!coupon) return res.send({ code: -1, message: '优惠券不存在' });
    res.send({ code: 0, data: formatCouponRecord(coupon) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/coupon/claim', async (req, res) => {
  try {
    const openid = req.headers['x-wx-openid'] || 'local_dev_user';
    const couponNo = String(req.body?.couponNo || '').trim();
    if (!couponNo) return res.send({ code: -1, message: '缺少优惠券编号' });

    const coupon = await CouponRecord.findOne({ where: { couponNo } });
    if (!coupon) return res.send({ code: -1, message: '优惠券不存在' });
    if (coupon.status === 'used') return res.send({ code: -1, message: '优惠券已核销' });
    if (coupon.status === 'claimed' && coupon.claimedByOpenid && coupon.claimedByOpenid !== openid) {
      return res.send({ code: -1, message: '优惠券已被领取' });
    }
    if (coupon.status === 'expired') return res.send({ code: -1, message: '优惠券已失效' });

    if (coupon.status === 'generated') {
      await coupon.update({
        status: 'claimed',
        claimedByOpenid: openid,
        claimedAt: new Date(),
      });
    }

    res.send({ code: 0, data: formatCouponRecord(coupon) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.get('/api/coupon/list', async (req, res) => {
  try {
    const openid = req.headers['x-wx-openid'] || 'local_dev_user';
    const status = String(req.query.status || 'default');
    const where = { claimedByOpenid: openid };
    if (status === 'default') where.status = 'claimed';
    if (status === 'useless') where.status = 'used';
    if (status === 'disabled') where.status = 'expired';

    const coupons = await CouponRecord.findAll({
      where,
      order: [['claimedAt', 'DESC'], ['createdAt', 'DESC']],
    });
    res.send({ code: 0, data: coupons.map(formatCouponRecord) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.get('/api/admin/coupons', adminAuth, async (req, res) => {
  try {
    const coupons = await CouponRecord.findAll({ order: [['createdAt', 'DESC']] });
    res.send({ code: 0, data: coupons.map(formatCouponRecord) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.get('/api/admin/coupon-templates', adminAuth, async (req, res) => {
  try {
    await ensureDefaultCouponTemplates();
    const templates = await CouponTemplate.findAll({ order: [['sort', 'DESC'], ['createdAt', 'ASC']] });
    res.send({ code: 0, data: templates.map(formatCouponTemplate) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/admin/coupon-templates', adminAuth, async (req, res) => {
  try {
    const payload = normalizeCouponTemplate(req.body || {});
    if (!payload.templateType) return res.send({ code: -1, message: '请填写模板标识' });
    if (!payload.title) return res.send({ code: -1, message: '请填写模板标题' });
    if (!['discount', 'amount', 'buy_x_get_y'].includes(payload.ruleType)) {
      return res.send({ code: -1, message: '规则类型仅支持 discount/amount/buy_x_get_y' });
    }
    if (payload.ruleType === 'discount' && (payload.value <= 0 || payload.value >= 10)) {
      return res.send({ code: -1, message: '折扣券 value 请填写 0-10 之间的折扣值，如 9 表示9折' });
    }
    if (payload.ruleType === 'amount' && payload.value <= 0) {
      return res.send({ code: -1, message: '满减券 value 请填写减免金额（分）' });
    }
    if (payload.ruleType === 'buy_x_get_y' && (!payload.minQuantity || !payload.value)) {
      return res.send({ code: -1, message: '买赠券请填写 minQuantity 和 value' });
    }

    await CouponTemplate.upsert(payload);
    const templates = await CouponTemplate.findAll({ order: [['sort', 'DESC'], ['createdAt', 'ASC']] });
    res.send({ code: 0, data: templates.map(formatCouponTemplate) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.get('/api/admin/coupon-admins', adminAuth, async (req, res) => {
  try {
    const admins = await AdminWhitelist.findAll({ order: [['createdAt', 'DESC']] });
    res.send({ code: 0, data: admins });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.get('/api/admin/latest-users', adminAuth, async (req, res) => {
  try {
    const users = await User.findAll({
      attributes: ['openid', 'nickName', 'avatarUrl', 'phoneNumber', 'updatedAt', 'createdAt'],
      order: [['updatedAt', 'DESC']],
      limit: 5,
    });
    res.send({ code: 0, data: users.map(formatUserInfo).map((user, index) => ({
      ...user,
      updatedAt: users[index].updatedAt,
      createdAt: users[index].createdAt,
    })) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/admin/coupon-admins', adminAuth, async (req, res) => {
  try {
    const openid = String(req.body?.openid || '').trim();
    const remark = String(req.body?.remark || '').trim();
    if (!openid) return res.send({ code: -1, message: '请填写 openid' });
    await AdminWhitelist.upsert({ openid, remark });
    const admins = await AdminWhitelist.findAll({ order: [['createdAt', 'DESC']] });
    res.send({ code: 0, data: admins });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.delete('/api/admin/coupon-admins/:openid', adminAuth, async (req, res) => {
  try {
    await AdminWhitelist.destroy({ where: { openid: req.params.openid } });
    res.send({ code: 0 });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// ============ 首页可替换资产接口 ============

// 获取首页 logo/icon 配置。数据库只需存文件名/相对路径，后端会拼成 cloud://.../homeAsset/...。
app.get('/api/home/assets', async (req, res) => {
  try {
    const rows = await HomeAsset.findAll({ order: [['assetKey', 'ASC']] });
    const assets = rows.map(formatHomeAsset);
    const assetMap = assets.reduce((result, item) => {
      result[item.key] = item;
      return result;
    }, {});

    res.send({
      code: 0,
      data: {
        definitions: HOME_ASSET_DEFINITIONS,
        assets,
        assetMap,
      },
    });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 初始化首页 logo/icon 资产种子数据（强制重置）
app.post('/api/home/assets/seed', async (req, res) => {
  try {
    await HomeAsset.destroy({ truncate: true });

    const seedData = [
      { assetKey: 'logo', label: '首页品牌 Logo', url: 'logo.png' },
      { assetKey: 'icon1', label: '肠道检测', url: 'icons/icon1.png' },
      { assetKey: 'icon2', label: '报告截图', url: 'icons/icon2.png' },
      { assetKey: 'icon3', label: '益生菌方案', url: 'icons/icon3.png' },
      { assetKey: 'icon4', label: '科普知识', url: 'icons/icon4.png' },
      { assetKey: 'nutritionPlaceholder', label: '首页占位图', url: 'icons/nutrition-placeholder.png' },
    ];

    await HomeAsset.bulkCreate(seedData);
    res.send({ code: 0, message: '首页资产种子数据初始化成功', data: { count: seedData.length } });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 配置或替换单个首页资产。支持 { fileName }、{ imageUrl } 或 { url }。
app.post('/api/home/assets/:key', saveHomeAsset);

// 兼容旧路径：POST /api/home/assets/logo/upload
app.post('/api/home/assets/:key/upload', saveHomeAsset);

// 获取首页轮播 Banner。数据来自独立 HomeBanner 表，便于数据库直接配置。
app.get('/api/home/banners', async (req, res) => {
  try {
    const rows = await HomeBanner.findAll({
      where: { status: 1 },
      order: [
        ['sort', 'DESC'],
        ['updatedAt', 'DESC'],
      ],
    });
    res.send({ code: 0, data: rows.map(formatHomeBanner) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 初始化首页 Banner 种子数据（强制重置）
app.post('/api/home/banners/seed', async (req, res) => {
  try {
    await HomeBanner.destroy({ truncate: true });

    const seedData = [
      {
        title: '首页益生菌 Banner',
        imageUrl: 'banner-test.png',
        linkType: 'product',
        linkValue: 'spu_probiotic_01',
        sort: 100,
        status: 1,
      }
    ];

    await HomeBanner.bulkCreate(seedData);
    res.send({ code: 0, message: '首页 Banner 种子数据初始化成功', data: { count: seedData.length } });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 获取商品列表
app.get('/api/products', async (req, res) => {
  try {
    const keyword = String(req.query.keyword || req.query.keywords || '').trim();
    const where = { status: 1 };

    if (keyword) {
      where[Op.or] = [
        { title: { [Op.like]: `%${keyword}%` } },
        { brief: { [Op.like]: `%${keyword}%` } },
        { badge: { [Op.like]: `%${keyword}%` } },
        { spuId: { [Op.like]: `%${keyword}%` } },
      ];
    }

    const products = await Product.findAll({
      where,
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
        'pictureSpuId',
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

    const baseProduct = {
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
    };

    const cloneProduct = (overrides) => {
      const product = {
        ...JSON.parse(JSON.stringify(baseProduct)),
        pictureSpuId: 'spu_probiotic_01',
        ...overrides,
      };
      const skuPrices = overrides.skuPrices || [
        product.minSalePrice,
        product.maxSalePrice,
        product.minSalePrice,
        product.maxSalePrice,
      ];
      product.skuList = product.skuList.map((sku, index) => ({
        ...sku,
        priceInfo: [
          { priceType: 1, price: String(skuPrices[index] || product.minSalePrice) },
          { priceType: 2, price: String(product.maxLinePrice) },
        ],
      }));
      delete product.skuPrices;
      return product;
    };

    const seedData = [
      baseProduct,
      cloneProduct({
        spuId: 'spu_probiotic_02',
        title: '清畅益生菌粉（儿童款）',
        brief: '温和配方搭配多种益生元，适合儿童日常肠道养护，帮助维持肠道菌群平衡。',
        price: 138,
        originalPrice: 198,
        badge: '儿童优选',
        sort: 26,
        minSalePrice: 13800,
        maxSalePrice: 16800,
        maxLinePrice: 19800,
        soldNum: 860,
        spuStockQuantity: 420,
      }),
      cloneProduct({
        spuId: 'spu_testkit_01',
        title: '肠道菌群检测盒（基础版）',
        brief: '居家采样，专业检测肠道菌群状态，生成可读报告，为后续益生菌方案提供参考。',
        price: 299,
        originalPrice: 399,
        badge: '检测盒',
        sort: 24,
        minSalePrice: 29900,
        maxSalePrice: 29900,
        maxLinePrice: 39900,
        soldNum: 520,
        spuStockQuantity: 300,
      }),
      cloneProduct({
        spuId: 'spu_probiotic_03',
        title: '舒敏益生菌粉（家庭装）',
        brief: '家庭分享装，覆盖日常营养补充和换季肠道管理场景，适合多人持续使用。',
        price: 218,
        originalPrice: 298,
        badge: '家庭装',
        sort: 22,
        minSalePrice: 21800,
        maxSalePrice: 25800,
        maxLinePrice: 29800,
        soldNum: 680,
        spuStockQuantity: 360,
      }),
    ];

    const cloudSeedData = seedData.map(withCloudProductPictures);
    await Product.bulkCreate(cloudSeedData);
    res.send({ code: 0, message: '种子数据初始化成功', data: { count: cloudSeedData.length } });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 初始化全部种子数据（强制重置）：商品 + 首页资产 + 首页 Banner
app.post('/api/seed', async (req, res) => {
  try {
    const steps = [
      { name: 'products', path: '/api/products/seed' },
      { name: 'homeAssets', path: '/api/home/assets/seed' },
      { name: 'homeBanners', path: '/api/home/banners/seed' },
    ];
    const results = [];

    for (const step of steps) {
      const result = await postLocalJson(step.path);
      if (!result || result.code !== 0) {
        throw new Error(`${step.name} seed failed: ${result?.message || 'unknown error'}`);
      }
      results.push({ name: step.name, result });
    }

    res.send({ code: 0, message: '全部种子数据初始化成功', data: results });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 兼容更语义化的路径
app.post('/api/seed/all', async (req, res) => {
  try {
    const results = [];
    for (const step of [
      { name: 'products', path: '/api/products/seed' },
      { name: 'homeAssets', path: '/api/home/assets/seed' },
      { name: 'homeBanners', path: '/api/home/banners/seed' },
    ]) {
      const result = await postLocalJson(step.path);
      if (!result || result.code !== 0) {
        throw new Error(`${step.name} seed failed: ${result?.message || 'unknown error'}`);
      }
      results.push({ name: step.name, result });
    }
    res.send({ code: 0, message: '全部种子数据初始化成功', data: results });
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
    const openid = req.headers['x-wx-openid'] || 'local_dev_user';
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
    const claimedCoupons = await CouponRecord.findAll({
      where: { claimedByOpenid: openid, status: 'claimed' },
      order: [['claimedAt', 'ASC'], ['createdAt', 'ASC']],
    });
    const couponCandidates = claimedCoupons.map((coupon) => ({
      coupon,
      amount: calculateCouponDiscount(coupon, skuDetailVos, totalSalePrice),
    }));
    const selectedCoupon = couponCandidates.find((item) => item.amount > 0) || null;
    const totalCouponAmount = selectedCoupon ? selectedCoupon.amount : 0;
    const totalPayAmount = Math.max(totalSalePrice - totalCouponAmount, 1);
    const couponList = couponCandidates.map(({ coupon, amount }) => {
      const formatted = formatCouponRecord(coupon);
      const isUsable = amount > 0;
      return {
        ...formatted,
        status: isUsable ? formatted.status : 'useless',
        selected: !!selectedCoupon && coupon.couponNo === selectedCoupon.coupon.couponNo,
        discountAmount: String(amount),
        unavailableReason: isUsable ? '' : getCouponUnavailableReason(coupon, skuDetailVos),
        desc: isUsable ? formatted.desc : getCouponUnavailableReason(coupon, skuDetailVos),
      };
    });

    res.send({
      code: 0,
      data: {
        settleType: 1,
        userAddress: null,
        totalGoodsCount,
        totalAmount: totalSalePrice,
        totalPayAmount,
        totalSalePrice,
        totalDiscountAmount: 0,
        totalPromotionAmount: 0,
        totalCouponAmount,
        totalDeliveryFee: 0,
        invoiceSupport: 0,
        selectedCoupon: selectedCoupon
          ? { ...formatCouponRecord(selectedCoupon.coupon), discountAmount: String(selectedCoupon.amount) }
          : null,
        storeGoodsList: [
          {
            storeId: '1',
            storeName: '立康林旗舰店',
            storeTotalPayAmount: totalPayAmount,
            skuDetailVos,
            couponList,
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

// ============ 检测样本接口 ============

app.get('/api/samples', async (req, res) => {
  try {
    const pageNum = Math.max(Number(req.query.page) || 1, 1);
    const pageSize = Math.max(Number(req.query.pageSize) || 10, 1);
    const type = String(req.query.type || '').trim();
    const where = type ? { type } : {};

    const { rows, count } = await Sample.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      offset: (pageNum - 1) * pageSize,
      limit: pageSize,
    });

    res.send({
      code: 0,
      data: rows.map(formatSample),
      total: count,
    });
  } catch (err) {
    console.error('获取样本列表失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

app.get('/api/samples/:id', async (req, res) => {
  try {
    const sample = await Sample.findByPk(req.params.id);
    if (!sample) {
      return res.send({ code: -1, message: '样本不存在' });
    }
    res.send({ code: 0, data: formatSample(sample) });
  } catch (err) {
    console.error('获取样本详情失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/samples', async (req, res) => {
  try {
    const openid = req.headers['x-wx-openid'] || 'local_dev_user';
    const payload = normalizeSamplePayload(req.body);
    if (!payload.sampleNo) {
      return res.send({ code: -1, message: '请填写样本编号' });
    }

    const existing = await Sample.findOne({ where: { sampleNo: payload.sampleNo } });
    if (existing) {
      return res.send({ code: -1, message: '样本编号已存在' });
    }

    const sample = await Sample.create({
      ...payload,
      openid,
      source: 'manual',
    });
    res.send({ code: 0, data: formatSample(sample) });
  } catch (err) {
    console.error('保存样本失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

app.put('/api/samples/:id', async (req, res) => {
  try {
    const sample = await Sample.findByPk(req.params.id);
    if (!sample) {
      return res.send({ code: -1, message: '样本不存在' });
    }

    const payload = normalizeSamplePayload(req.body);
    if (!payload.sampleNo) {
      return res.send({ code: -1, message: '请填写样本编号' });
    }

    const duplicated = await Sample.findOne({
      where: {
        sampleNo: payload.sampleNo,
        id: { [Op.ne]: sample.id },
      },
    });
    if (duplicated) {
      return res.send({ code: -1, message: '样本编号已存在' });
    }

    await sample.update(payload);
    res.send({ code: 0, data: formatSample(sample) });
  } catch (err) {
    console.error('更新样本失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

// ============ 售后/退货接口 ============

app.get('/api/after-sale/preview', async (req, res) => {
  try {
    const { orderNo, skuId, numOfSku = 1 } = req.query;
    const order = await Order.findOne({ where: { orderNo } });
    if (!order) return res.send({ code: -1, message: '订单不存在' });

    const goodsList = Array.isArray(order.goodsList) ? order.goodsList : [];
    const goods = goodsList.find((item) => String(item.skuId || item.id) === String(skuId)) || goodsList[0] || {};
    const quantity = Number(goods.quantity || goods.buyQuantity || 1);
    const price = Number(goods.price || goods.actualPrice || goods.settlePrice || 0);
    const applyNum = Math.min(Number(numOfSku) || 1, quantity);

    res.send({
      code: 0,
      data: {
        spuId: goods.spuId || '',
        skuId: goods.skuId || skuId || goods.id || '',
        goodsInfo: {
          goodsName: goods.goodsName || goods.title || '商品名称',
          skuImage: goods.thumb || goods.image || goods.primaryImage || '',
          specInfo: normalizeSpecs(goods),
        },
        paidAmountEach: String(price),
        boughtQuantity: quantity,
        refundableAmount: String(price * applyNum),
        shippingFeeIncluded: '0',
        numOfSku: applyNum,
        numOfSkuAvailable: quantity,
      },
    });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.get('/api/after-sale/reasons', (req, res) => {
  const rightsReasonList = [
    { id: 'QUALITY', desc: '商品质量问题' },
    { id: 'DESC_DIFF', desc: '商品与描述不符' },
    { id: 'WRONG_GOODS', desc: '发错/漏发' },
    { id: 'NEGOTIATED', desc: '与商家协商一致' },
    { id: 'OTHER', desc: '其他原因' },
  ];
  res.send({ code: 0, data: { rightsReasonList } });
});

app.post('/api/after-sale/apply', async (req, res) => {
  try {
    const { rights = {}, rightsItem = [], refundMemo = '' } = req.body || {};
    const order = await Order.findOne({ where: { orderNo: rights.orderNo } });
    if (!order) return res.send({ code: -1, message: '订单不存在' });

    const goodsList = Array.isArray(order.goodsList) ? order.goodsList : [];
    const items = (rightsItem || []).map((item, index) => {
      const goods =
        goodsList.find((goodsItem) => String(goodsItem.skuId || goodsItem.id) === String(item.skuId)) ||
        goodsList[index] ||
        {};
      const price = Number(goods.price || goods.actualPrice || goods.settlePrice || 0);
      const quantity = Number(item.rightsQuantity || 1);
      return {
        actualPrice: price,
        goodsName: goods.goodsName || goods.title || '商品名称',
        goodsPictureUrl: goods.thumb || goods.image || goods.primaryImage || '',
        itemRefundAmount: Number(rights.refundRequestAmount || price * quantity),
        itemTotalAmount: price * quantity,
        rightsQuantity: quantity,
        skuId: item.skuId || goods.skuId || goods.id || '',
        spuId: item.spuId || goods.spuId || '',
        specInfo: normalizeSpecs(goods),
      };
    });

    const rightsNo = `AS${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const isReturnGoods = Number(rights.rightsType) === 10;
    const afterSale = await AfterSale.create({
      rightsNo,
      orderNo: rights.orderNo,
      openid: order.openid || '',
      rightsType: rights.rightsType || 20,
      rightsStatus: isReturnGoods ? AFTER_SERVICE_STATUS.THE_APPROVED : AFTER_SERVICE_STATUS.TO_AUDIT,
      userRightsStatus: isReturnGoods ? SERVICE_STATUS.PENDING_DELIVERY : SERVICE_STATUS.PENDING_VERIFY,
      refundRequestAmount: String(rights.refundRequestAmount || 0),
      refundAmount: String(rights.refundRequestAmount || 0),
      rightsReasonDesc: rights.rightsReasonDesc || '',
      rightsReasonType: rights.rightsReasonType || '',
      refundMemo: typeof refundMemo === 'string' ? refundMemo : '',
      rightsImageUrls: rights.rightsImageUrls || [],
      rightsItems: items,
      logistics: {},
    });

    if (isReturnGoods) {
      try {
        const returnId = await createWechatReturnId({ afterSale, order });
        if (returnId) {
          await afterSale.update({ returnId });
        }
      } catch (err) {
        console.warn('创建微信退货 ID 失败，已保留本地售后单:', err.message);
      }
    }

    res.send({ code: 0, data: { rightsNo: afterSale.rightsNo } });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.get('/api/after-sale/list', async (req, res) => {
  try {
    const pageNum = Math.max(Number(req.query.pageNum) || 1, 1);
    const pageSize = Math.max(Number(req.query.pageSize) || 10, 1);
    const afterServiceStatus = req.query.afterServiceStatus;
    const where = {};
    if (afterServiceStatus !== undefined && afterServiceStatus !== '' && Number(afterServiceStatus) !== -1) {
      where.rightsStatus = Number(afterServiceStatus);
    }
    const { rows, count } = await AfterSale.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      offset: (pageNum - 1) * pageSize,
      limit: pageSize,
    });
    const allRows = await AfterSale.findAll();
    const countByStatus = (status) => allRows.filter((item) => Number(item.rightsStatus) === status).length;
    res.send({
      code: 0,
      data: {
        pageNum,
        pageSize,
        totalCount: count,
        states: {
          audit: countByStatus(AFTER_SERVICE_STATUS.TO_AUDIT),
          approved: countByStatus(AFTER_SERVICE_STATUS.THE_APPROVED),
          complete: countByStatus(AFTER_SERVICE_STATUS.COMPLETE),
          closed: countByStatus(AFTER_SERVICE_STATUS.CLOSED),
        },
        dataList: rows.map(formatAfterSaleForMiniProgram),
      },
    });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.get('/api/after-sale/detail/:rightsNo', async (req, res) => {
  try {
    const afterSale = await AfterSale.findOne({ where: { rightsNo: req.params.rightsNo } });
    if (!afterSale) return res.send({ code: -1, message: '售后单不存在' });
    res.send({ code: 0, data: [formatAfterSaleForMiniProgram(afterSale)] });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/after-sale/logistics', async (req, res) => {
  try {
    const { rightsNo, logisticsCompanyCode, logisticsCompanyName, logisticsNo, remark } = req.body || {};
    const afterSale = await AfterSale.findOne({ where: { rightsNo } });
    if (!afterSale) return res.send({ code: -1, message: '售后单不存在' });
    await afterSale.update({
      userRightsStatus: SERVICE_STATUS.PENDING_DELIVERY,
      logistics: { logisticsCompanyCode, logisticsCompanyName, logisticsNo, remark },
    });
    res.send({ code: 0, data: formatAfterSaleForMiniProgram(afterSale) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/after-sale/cancel', async (req, res) => {
  try {
    const { rightsNo } = req.body || {};
    const afterSale = await AfterSale.findOne({ where: { rightsNo } });
    if (!afterSale) return res.send({ code: -1, message: '售后单不存在' });
    await afterSale.update({
      rightsStatus: AFTER_SERVICE_STATUS.CLOSED,
      userRightsStatus: SERVICE_STATUS.CLOSED,
    });
    res.send({ code: 0, data: formatAfterSaleForMiniProgram(afterSale) });
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
    const afterSaleMap = await fetchAfterSalesForOrders(rows.map((order) => order.orderNo));

    const statuses = [-1, 5, 10, 40, 50, ORDER_STATUS_RETURNING, ORDER_STATUS_REFUNDED];
    const tabCounts = await Promise.all(
      statuses.map(async (status) => ({
        tabType: status,
        orderNum: status === -1 ? await Order.count() : await Order.count({ where: { orderStatus: status } }),
      })),
    );

    res.send({
      code: 0,
      data: {
        orders: rows.map((order) => formatOrderForMiniProgram(order, afterSaleMap[order.orderNo] || [])),
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

    if (Number(order.orderStatus) === 40) {
      try {
        await syncOrderFromWechatOrderState(order, '订单详情查询');
      } catch (syncErr) {
        console.warn('微信订单状态同步跳过:', order.orderNo, syncErr.message);
      }
    }

    const afterSales = await fetchAfterSalesForOrder(order.orderNo);
    res.send({ code: 0, data: formatOrderForMiniProgram(order, afterSales) });
  } catch (err) {
    console.error('获取订单详情失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/order/logistics/test-update', async (req, res) => {
  try {
    const {
      orderNo = 'ORD1779679337988cpvs',
      transactionId = '4200003048202605259472182317',
      actionType = 200001,
      action_type,
      logisticsNo,
      logisticsCompanyCode = WX_TEST_DELIVERY_ID,
      logisticsCompanyName = '微信测试物流',
    } = req.body || {};

    const order = await Order.findOne({ where: { orderNo } });
    if (!order) {
      return res.send({ code: -1, message: '订单不存在' });
    }

    const waybillId = String(logisticsNo || `TEST${String(transactionId || order.transactionId || orderNo).slice(-12)}`);
    const nextActionType = action_type || actionType;
    const actionConfig = getLogisticsActionConfig(nextActionType);
    const trajectoryVos = mergeTrajectory(order.trajectoryVos || [], nextActionType);
    const wechatResult = await testUpdateWechatLogisticsOrder({
      orderNo,
      waybillId,
      actionType: nextActionType,
    });

    const wechatWarning =
      wechatResult && wechatResult.errcode
        ? wechatResult.errmsg || `微信测试物流更新失败：${wechatResult.errcode}`
        : '';

    await order.update({
      orderStatus: actionConfig.orderStatus,
      orderStatusName: actionConfig.orderStatusName,
      transactionId: transactionId || order.transactionId,
      logisticsNo: waybillId,
      logisticsCompanyCode,
      logisticsCompanyName,
      trajectoryVos,
    });
    const afterSales = await fetchAfterSalesForOrder(order.orderNo);

    res.send({
      code: 0,
      message: wechatWarning
        ? `本地订单物流已更新；微信测试接口未更新：${wechatWarning}`
        : '测试物流状态已更新',
      data: {
        wechatResult,
        wechatWarning,
        order: formatOrderForMiniProgram(order, afterSales),
      },
    });
  } catch (err) {
    console.error('测试物流状态更新失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/order/logistics/waybill-token', async (req, res) => {
  try {
    const { orderNo, orderId } = req.body || {};
    const conditions = [];
    if (orderNo) conditions.push({ orderNo });
    if (orderId && /^\d+$/.test(String(orderId))) conditions.push({ id: Number(orderId) });
    if (!conditions.length) return res.send({ code: -1, message: '缺少订单标识' });

    const order = await Order.findOne({ where: { [Op.or]: conditions } });
    if (!order) return res.send({ code: -1, message: '订单不存在' });

    if (order.waybillToken) {
      return res.send({
        code: 0,
        data: {
          waybillToken: order.waybillToken,
          order: formatOrderForMiniProgram(order, await fetchAfterSalesForOrder(order.orderNo)),
        },
      });
    }

    const traced = await traceWechatWaybill(order);
    if (!traced.waybillToken) {
      return res.send({
        code: -1,
        message: '微信未返回物流查询凭证',
        data: traced.result,
      });
    }

    await order.update({ waybillToken: traced.waybillToken });
    const afterSales = await fetchAfterSalesForOrder(order.orderNo);

    res.send({
      code: 0,
      data: {
        waybillToken: traced.waybillToken,
        wechatResult: traced.result,
        order: formatOrderForMiniProgram(order, afterSales),
      },
    });
  } catch (err) {
    console.error('获取微信物流凭证失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

const findOrderNoFromWechatNotify = (payload = {}) => {
  const directKeys = [
    'out_trade_no',
    'merchant_trade_no',
    'order_no',
    'orderNo',
    'order_id',
    'orderId',
  ];

  for (const key of directKeys) {
    if (payload[key]) return String(payload[key]);
  }

  for (const value of Object.values(payload)) {
    if (value && typeof value === 'object') {
      const nested = findOrderNoFromWechatNotify(value);
      if (nested) return nested;
    }
  }

  return '';
};

app.post('/api/order/wechat/notify', async (req, res) => {
  try {
    if (!wxPayConfig.apiV3Key && req.body && req.body.resource) {
      return res.status(500).send({ code: 'FAIL', message: 'WECHAT_PAY_API_V3_KEY 未配置' });
    }

    const notifyBody = req.body || {};
    const payload = notifyBody.resource ? decryptNotifyResource(notifyBody.resource) : notifyBody;
    const orderNo = findOrderNoFromWechatNotify(payload);
    if (!orderNo) {
      console.warn('微信订单通知未识别订单号:', JSON.stringify(payload));
      return res.send({ code: 'SUCCESS', message: '忽略无订单号通知' });
    }

    const order = await Order.findOne({ where: { orderNo } });
    if (!order) {
      console.warn('微信订单通知对应本地订单不存在:', orderNo);
      return res.send({ code: 'SUCCESS', message: '本地订单不存在，已忽略' });
    }

    await syncOrderFromWechatOrderState(order, '微信通知');
    res.send({ code: 'SUCCESS', message: '成功' });
  } catch (err) {
    console.error('微信订单通知处理失败:', err);
    res.status(500).send({ code: 'FAIL', message: err.message });
  }
});

app.post('/api/order/wechat/sync', async (req, res) => {
  try {
    const { orderNo, orderId } = req.body || {};
    const conditions = [];
    if (orderNo) conditions.push({ orderNo });
    if (orderId && /^\d+$/.test(String(orderId))) conditions.push({ id: Number(orderId) });
    if (!conditions.length) return res.send({ code: -1, message: '缺少订单标识' });

    const order = await Order.findOne({ where: { [Op.or]: conditions } });
    if (!order) return res.send({ code: -1, message: '订单不存在' });

    const syncResult = await syncOrderFromWechatOrderState(order, '手动同步');
    const afterSales = await fetchAfterSalesForOrder(order.orderNo);
    res.send({
      code: 0,
      data: {
        ...syncResult,
        order: formatOrderForMiniProgram(order, afterSales),
      },
    });
  } catch (err) {
    console.error('微信订单状态同步失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/order/confirm-received', async (req, res) => {
  try {
    const { orderNo, orderId } = req.body || {};
    const conditions = [];
    if (orderNo) conditions.push({ orderNo });
    if (orderId && /^\d+$/.test(String(orderId))) conditions.push({ id: Number(orderId) });
    if (!conditions.length) return res.send({ code: -1, message: '缺少订单标识' });

    const order = await Order.findOne({ where: { [Op.or]: conditions } });
    if (!order) return res.send({ code: -1, message: '订单不存在' });
    if (Number(order.orderStatus) !== 40) {
      return res.send({ code: -1, message: '当前订单状态不可确认收货' });
    }

    await order.update({
      orderStatus: 50,
      orderStatusName: '交易完成',
      trajectoryVos: mergeTrajectory(order.trajectoryVos || [], 300003),
    });
    const afterSales = await fetchAfterSalesForOrder(order.orderNo);

    res.send({ code: 0, data: formatOrderForMiniProgram(order, afterSales) });
  } catch (err) {
    console.error('确认收货失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/order/auto-confirm-received/run', adminAuth, async (req, res) => {
  try {
    const result = await autoConfirmReceivedOrders();
    res.send({ code: 0, data: result });
  } catch (err) {
    console.error('手动执行自动确认收货失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/order/wechat/msg-jump-path', adminAuth, async (req, res) => {
  try {
    const result = await setWechatOrderMsgJumpPath(req.body?.path || WECHAT_ORDER_MSG_JUMP_PATH);
    res.send({ code: 0, data: { path: req.body?.path || WECHAT_ORDER_MSG_JUMP_PATH, result } });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.get('/api/admin/order/:id', adminAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const conditions = [{ orderNo: id }];
    if (/^\d+$/.test(id)) {
      conditions.push({ id: Number(id) });
    }

    const order = await Order.findOne({ where: { [Op.or]: conditions } });
    if (!order) {
      return res.send({ code: -1, message: '订单不存在' });
    }

    const afterSales = await fetchAfterSalesForOrder(order.orderNo);
    res.send({ code: 0, data: formatOrderForMiniProgram(order, afterSales) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.get('/api/admin/orders', adminAuth, async (req, res) => {
  try {
    const pageNum = Math.max(Number(req.query.pageNum) || 1, 1);
    const showAll = req.query.pageSize === 'all';
    const pageSize = showAll ? undefined : Math.max(Number(req.query.pageSize) || 50, 1);
    const orderStatus = req.query.orderStatus;
    const where = {};

    if (orderStatus !== undefined && orderStatus !== '' && Number(orderStatus) !== -1) {
      where.orderStatus = Number(orderStatus);
    }

    const findOptions = {
      where,
      order: [['createdAt', 'DESC']],
    };
    if (!showAll) {
      findOptions.offset = (pageNum - 1) * pageSize;
      findOptions.limit = pageSize;
    }

    const { rows, count } = await Order.findAndCountAll(findOptions);
    const afterSaleMap = await fetchAfterSalesForOrders(rows.map((order) => order.orderNo));
    const statuses = [-1, 5, 10, 40, 50, ORDER_STATUS_RETURNING, ORDER_STATUS_REFUNDED];
    const tabCounts = await Promise.all(
      statuses.map(async (status) => ({
        tabType: status,
        orderNum: status === -1 ? await Order.count() : await Order.count({ where: { orderStatus: status } }),
      })),
    );

    res.send({
      code: 0,
      data: {
        orders: rows.map((order) => formatOrderForMiniProgram(order, afterSaleMap[order.orderNo] || [])),
        total: count,
        pageNum,
        pageSize: showAll ? 'all' : pageSize,
        tabCounts,
      },
    });
  } catch (err) {
    console.error('获取管理订单列表失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/admin/order/ship', adminAuth, async (req, res) => {
  try {
    const {
      orderNo,
      trackingNo,
      expressCompany,
      expressCompanyName,
      itemDesc,
      receiverContact,
      localOnly = false,
    } = req.body || {};

    if (!orderNo) return res.send({ code: -1, message: '请填写订单号' });
    if (!trackingNo) return res.send({ code: -1, message: '请填写物流单号' });
    if (!expressCompany) return res.send({ code: -1, message: '请填写微信快递公司编码，如 SF、YTO、ZTO' });

    const order = await Order.findOne({ where: { orderNo } });
    if (!order) return res.send({ code: -1, message: '订单不存在' });

    const shippingPayload = buildWechatShippingPayload({
      order,
      trackingNo,
      expressCompany,
      itemDesc,
      receiverContact,
    });

    let wechatResult = { skipped: true, errmsg: '已选择仅更新本地订单' };
    let wechatWarning = '';
    if (!localOnly) {
      try {
        wechatResult = await uploadWechatShippingInfo(shippingPayload);
        try {
          await setWechatOrderMsgJumpPath();
        } catch (jumpErr) {
          console.warn('微信订单消息跳转路径设置失败:', jumpErr.message);
        }
      } catch (wechatErr) {
        wechatResult = wechatErr.wechatResult || { errmsg: wechatErr.message };
        wechatWarning = wechatErr.message;
        console.warn('微信发货同步失败，已继续更新本地订单:', orderNo, wechatErr.message);
      }
    }

    const trajectoryVos = mergeTrajectory(order.trajectoryVos || [], 200003);
    await order.update({
      orderStatus: 40,
      orderStatusName: '待收货',
      logisticsNo: trackingNo,
      logisticsCompanyCode: expressCompany,
      logisticsCompanyName: expressCompanyName || expressCompany,
      trajectoryVos,
    });
    const afterSales = await fetchAfterSalesForOrder(order.orderNo);

    res.send({
      code: 0,
      message: localOnly
        ? '本地订单已发货'
        : wechatWarning
          ? `本地订单已发货；微信发货未同步：${wechatWarning}`
          : '本地订单与微信发货信息已同步',
      data: {
        wechatResult,
        wechatWarning,
        shippingPayload,
        order: formatOrderForMiniProgram(order, afterSales),
      },
    });
  } catch (err) {
    console.error('发货同步失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/admin/order/payment-amount', adminAuth, async (req, res) => {
  try {
    const { orderNo, paymentAmount } = req.body || {};
    const amount = Math.round(Number(paymentAmount));
    if (!orderNo) return res.send({ code: -1, message: '请填写订单号' });
    if (!Number.isFinite(amount) || amount <= 0) return res.send({ code: -1, message: '请填写有效实付金额（分）' });

    const order = await Order.findOne({ where: { orderNo } });
    if (!order) return res.send({ code: -1, message: '订单不存在' });
    if (Number(order.orderStatus) !== 5) {
      return res.send({ code: -1, message: '仅待付款订单可以修改付款金额' });
    }

    await order.update({
      paymentAmount: String(amount),
      prepayId: null,
    });
    const afterSales = await fetchAfterSalesForOrder(order.orderNo);

    res.send({ code: 0, data: formatOrderForMiniProgram(order, afterSales) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/admin/order/return', adminAuth, async (req, res) => {
  try {
    const { orderNo, reason = '' } = req.body || {};
    if (!orderNo) return res.send({ code: -1, message: '请填写订单号' });

    const order = await Order.findOne({ where: { orderNo } });
    if (!order) return res.send({ code: -1, message: '订单不存在' });

    const currentStatus = Number(order.orderStatus);
    if (![40, 50, ORDER_STATUS_RETURNING].includes(currentStatus)) {
      return res.send({ code: -1, message: '只有待收货或交易完成订单可以进入退货中' });
    }

    if (currentStatus !== ORDER_STATUS_RETURNING) {
      await order.update({
        orderStatus: ORDER_STATUS_RETURNING,
        orderStatusName: '退货中',
        remark: reason ? `${order.remark || ''}${order.remark ? '\n' : ''}退货备注：${String(reason).slice(0, 200)}` : order.remark,
      });
    }

    const afterSales = await fetchAfterSalesForOrder(order.orderNo);
    res.send({
      code: 0,
      message: '订单已进入退货中',
      data: formatOrderForMiniProgram(order, afterSales),
    });
  } catch (err) {
    console.error('管理端设置退货中失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/admin/order/refund', adminAuth, async (req, res) => {
  try {
    const { orderNo, refundAmount, reason = '订单退款' } = req.body || {};
    if (!orderNo) return res.send({ code: -1, message: '请填写订单号' });
    if (!isWxPayConfigured()) return res.send({ code: -1, message: '未配置微信支付，不能发起退款' });

    const order = await Order.findOne({ where: { orderNo } });
    if (!order) return res.send({ code: -1, message: '订单不存在' });
    if (Number(order.orderStatus) !== ORDER_STATUS_RETURNING) {
      return res.send({ code: -1, message: '只有退货中订单可以退款' });
    }

    const paidAmount = Math.round(Number(order.paymentAmount || order.totalAmount || 0));
    const amount = refundAmount === undefined || refundAmount === null || refundAmount === ''
      ? paidAmount
      : Math.round(Number(refundAmount));
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.send({ code: -1, message: '退款金额异常' });
    }
    if (amount > paidAmount) {
      return res.send({ code: -1, message: '退款金额不能大于客户实付金额' });
    }

    let wechatRefund;
    try {
      wechatRefund = await createWechatRefund({
        orderNo: order.orderNo,
        transactionId: order.transactionId,
        totalAmount: paidAmount,
        refundAmount: amount,
        reason,
      });
    } catch (err) {
      return res.send({
        code: -1,
        message: err.message || '微信退款失败',
        data: {
          wechatResult: err.wechatResult || null,
        },
      });
    }

    await order.update({
      orderStatus: ORDER_STATUS_REFUNDED,
      orderStatusName: '已退款',
      remark: `${order.remark || ''}${order.remark ? '\n' : ''}退款单号：${wechatRefund.outRefundNo}`,
    });

    const afterSales = await fetchAfterSalesForOrder(order.orderNo);
    res.send({
      code: 0,
      message: '微信退款已发起，订单已标记为已退款',
      data: {
        wechatRefund,
        order: formatOrderForMiniProgram(order, afterSales),
      },
    });
  } catch (err) {
    console.error('管理端退款失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

// 创建订单
app.post('/api/order/create', async (req, res) => {
  try {
    const headerOpenid = req.headers['x-wx-openid'] || '';
    const {
      goodsList = [],
      userAddress,
      userName,
      totalAmount,
      remark,
      authorizationCode,
      waybillToken,
      logisticsNo,
      logisticsCompanyCode,
      logisticsCompanyName,
      couponNo,
    } = req.body;
    const codeOpenid = await getOpenidByCode(authorizationCode);
    const openid = headerOpenid || codeOpenid || 'local_dev_user';

    // 后端重新计算总价（以防前端篡改）
    const calcTotal = goodsList.reduce((sum, g) => sum + (Number(g.price) || 0) * (Number(g.quantity) || 1), 0);
    if (calcTotal <= 0) {
      return res.send({ code: -1, message: '订单金额异常' });
    }
    const couponWhere = { claimedByOpenid: openid, status: 'claimed' };
    if (couponNo) couponWhere.couponNo = String(couponNo);
    const claimedCoupons = await CouponRecord.findAll({
      where: couponWhere,
      order: [['claimedAt', 'ASC'], ['createdAt', 'ASC']],
    });
    const selectedCoupon = claimedCoupons
      .map((coupon) => ({
        coupon,
        amount: calculateCouponDiscount(coupon, goodsList, calcTotal),
      }))
      .find((item) => item.amount > 0);
    const couponAmount = selectedCoupon ? selectedCoupon.amount : 0;
    const paymentAmount = Math.max(calcTotal - couponAmount, 1);
    const couponSnapshot = selectedCoupon
      ? { ...formatCouponRecord(selectedCoupon.coupon), discountAmount: String(couponAmount) }
      : null;

    const orderNo = 'ORD' + Date.now() + Math.random().toString(36).slice(2, 6);

    const order = await Order.create({
      orderNo,
      openid,
      orderStatus: 5,
      orderStatusName: '待付款',
      totalAmount: String(calcTotal),
      paymentAmount: String(paymentAmount),
      couponNo: selectedCoupon ? selectedCoupon.coupon.couponNo : null,
      couponAmount: String(couponAmount),
      couponSnapshot,
      goodsList: goodsList, // 完整商品快照（含名称、图片、规格、单价、数量）
      userAddress: userAddress || null,
      userName: userName || '',
      remark: remark || '',
      waybillToken: waybillToken || null,
      logisticsNo: logisticsNo || null,
      logisticsCompanyCode: logisticsCompanyCode || null,
      logisticsCompanyName: logisticsCompanyName || null,
    });

    console.log('✅ 订单已写入数据库:', order.orderNo, '商品数:', goodsList.length, '总价:', calcTotal);

    let payData = null;
    if (isWxPayConfigured() && openid !== 'local_dev_user') {
      const firstGoodsName = goodsList[0] && goodsList[0].goodsName;
      const { payAmount, prepayId, payInfo, outTradeNo, out_trade_no } = await createWechatPrepay({
        orderNo,
        openid,
        amount: paymentAmount,
        description: firstGoodsName || `订单${orderNo}`,
      });
      await order.update({ prepayId, paymentAmount: String(payAmount) });
      payData = {
        channel: 'wechat',
        tradeNo: order.orderNo,
        outTradeNo,
        out_trade_no,
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
        outTradeNo: order.orderNo,
        out_trade_no: order.orderNo,
        totalAmount: order.totalAmount,
        paymentAmount: order.paymentAmount,
        couponNo: order.couponNo,
        couponAmount: order.couponAmount,
        couponSnapshot: order.couponSnapshot,
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

// 已有待付款订单继续支付
app.post('/api/order/pay', async (req, res) => {
  try {
    const headerOpenid = req.headers['x-wx-openid'] || '';
    const { orderId, orderNo, authorizationCode } = req.body || {};
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
    if (Number(order.orderStatus) !== 5) {
      return res.send({ code: -1, message: '当前订单状态不可支付' });
    }

    const codeOpenid = await getOpenidByCode(authorizationCode);
    const openid = headerOpenid || codeOpenid || order.openid || 'local_dev_user';

    if (openid && openid !== 'local_dev_user' && openid !== order.openid) {
      await order.update({ openid });
    }

    let payData = null;
    if (isWxPayConfigured() && openid !== 'local_dev_user') {
      const goodsList = Array.isArray(order.goodsList) ? order.goodsList : [];
      const firstGoodsName = goodsList[0] && (goodsList[0].goodsName || goodsList[0].title);
      const orderAmount = Number(order.paymentAmount || order.totalAmount || 0);
      if (orderAmount <= 0) {
        return res.send({ code: -1, message: '订单金额异常' });
      }

      const { payAmount, prepayId, payInfo, outTradeNo, out_trade_no } = await createWechatPrepay({
        orderNo: order.orderNo,
        openid,
        amount: orderAmount,
        description: firstGoodsName || `订单${order.orderNo}`,
      });
      await order.update({ prepayId, paymentAmount: String(payAmount) });
      payData = {
        channel: 'wechat',
        tradeNo: order.orderNo,
        outTradeNo,
        out_trade_no,
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
        outTradeNo: order.orderNo,
        out_trade_no: order.orderNo,
        totalAmount: order.totalAmount,
        paymentAmount: order.paymentAmount,
        orderStatus: order.orderStatus,
        goodsList: order.goodsList,
        ...payData,
      },
    });
  } catch (err) {
    console.error('继续支付失败:', err);
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
      await redeemCouponForOrder(order);
    }

    const afterSales = await fetchAfterSalesForOrder(order.orderNo);
    res.send({ code: 0, data: formatOrderForMiniProgram(order, afterSales) });
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
      await redeemCouponForOrder(order);
      console.log('✅ 微信支付成功:', order.orderNo, payResult.transaction_id);
    }

    res.send({ code: 'SUCCESS', message: '成功' });
  } catch (err) {
    console.error('微信支付通知处理失败:', err);
    res.status(500).send({ code: 'FAIL', message: err.message });
  }
});

const port = process.env.PORT || 3000;

function postLocalJson(pathName) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathName, method: 'POST' }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : null);
        } catch (err) {
          reject(new Error(`${pathName} 返回非 JSON：${body}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const postLocalSeed = (pathName, label) => {
  postLocalJson(pathName)
    .then((body) => console.log(`🌱 ${label}:`, JSON.stringify(body)))
    .catch((err) => console.error(`🌱 ${label}失败:`, err.message));
};

async function bootstrap() {
  await initDB();
  await ensureDefaultCouponTemplates();
  startAutoConfirmReceivedTask();

  // 本地开发模式下自动插入种子数据（SQLite 内存库每次重启都是空的）
  if (!process.env.MYSQL_ADDRESS) {
    const productCount = await Product.count();
    const assetCount = await HomeAsset.count();
    const bannerCount = await HomeBanner.count();
    if (productCount === 0 || assetCount === 0 || bannerCount === 0) {
      console.log('🌱 本地模式：自动插入种子数据...');
      app.listen(port, () => {
        console.log('启动成功', port);
        if (productCount === 0) {
          postLocalSeed('/api/products/seed', '商品种子数据');
        }
        if (assetCount === 0) {
          postLocalSeed('/api/home/assets/seed', '首页资产种子数据');
        }
        if (bannerCount === 0) {
          postLocalSeed('/api/home/banners/seed', '首页 Banner 种子数据');
        }
      });
      return;
    }
  }

  app.listen(port, () => {
    console.log('启动成功', port);
  });
}

bootstrap().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
