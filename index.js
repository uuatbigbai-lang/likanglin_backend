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
  UserAvatar,
  Product,
  Address,
  CartItem,
  Order,
  AfterSale,
  AdminWhitelist,
  SalesProfile,
  UserSalesBinding,
  UserSalesBindingRecord,
  CouponTemplate,
  CouponRecord,
  CouponShareRecord,
  Sample,
  HomeAsset,
  HomeBanner,
  AdminAccount,
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
const {
  createAdminAuth,
  registerAdminAuthRoutes,
  buildSeedAdminAccounts,
} = require('./adminAuth');
const { registerOrderNotificationHooks } = require('./orderNotifier');

const logger = morgan('tiny');

registerOrderNotificationHooks(Order);

const HOME_ASSET_DEFINITIONS = [
  { key: 'logo', label: '首页品牌 Logo' },
  { key: 'fullLogo', label: '首页完整品牌 Logo' },
  { key: 'aboutDescription', label: '首页关于我们文案' },
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
    content: data.content || '',
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
const ORDER_AUTO_CANCEL_MS = Math.max(Number(process.env.ORDER_AUTO_CANCEL_MS) || 30 * 60 * 1000, 60 * 1000);

const DEFAULT_COUPON_TEMPLATES = [
  {
    templateType: 'eight',
    title: '8折券',
    ruleType: 'discount',
    value: 8,
    thresholdAmount: 0,
    minQuantity: 0,
    desc: '订单商品金额可享8折优惠',
    sort: 50,
  },
  {
    templateType: 'seven',
    title: '7折券',
    ruleType: 'discount',
    value: 7,
    thresholdAmount: 0,
    minQuantity: 0,
    desc: '订单商品金额可享7折优惠',
    sort: 40,
  },
  {
    templateType: 'five',
    title: '5折券',
    ruleType: 'discount',
    value: 5,
    thresholdAmount: 0,
    minQuantity: 0,
    desc: '订单商品金额可享5折优惠',
    sort: 30,
  },
  {
    templateType: 'buy2get1',
    title: '买二送一券',
    ruleType: 'buy_x_get_y',
    value: 1,
    thresholdAmount: 0,
    minQuantity: 3,
    desc: '订单内商品每满3件自动减1件，按商品数量累计抵扣',
    sort: 20,
  },
  {
    templateType: 'employee_special',
    title: '员工特别优惠',
    ruleType: 'employee_price',
    value: 0,
    thresholdAmount: 0,
    minQuantity: 0,
    desc: '按商品已配置的员工价结算，仅对配置了员工价的商品生效',
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
        : ruleType === 'buy_x_get_y'
          ? `订单满${minQuantity}件，免除最低价${value || 1}件商品金额`
          : '按商品员工价自动结算'
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
    scopeSpuIds: Array.isArray(template.scopeSpuIds) ? template.scopeSpuIds : [],
    scopeGoods: Array.isArray(template.scopeGoods) ? template.scopeGoods : [],
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
    await CouponTemplate.upsert(normalized);
  }
};

const getActiveCouponTemplate = async (templateType) => {
  const template = await CouponTemplate.findOne({
    where: { templateType: String(templateType || '').trim(), status: 1 },
  });
  return template ? formatCouponTemplate(template) : null;
};

const buildCouponNo = () => `CP${Date.now()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const buildCouponShareId = () => `CS${Date.now()}${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

const isCouponAdmin = async (openid) => {
  if (!openid) return false;
  const count = await AdminWhitelist.count({ where: { openid } });
  return count > 0;
};

// 现有“销售”角色由后台绑定管理维护，作为优惠券可继续转发的员工身份。
const isCouponEmployee = async (openid) => {
  if (!openid) return false;
  return (await SalesProfile.count({ where: { openid } })) > 0;
};

const getCouponRootNo = (coupon) => {
  const data = typeof coupon?.toJSON === 'function' ? coupon.toJSON() : coupon || {};
  return String(data.rootCouponNo || data.couponNo || '').trim();
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
    forwarded: 'disabled',
  };
  const statusTextMap = {
    generated: '待认领',
    claimed: '待使用',
    used: '已核销',
    expired: '已作废',
    forwarded: '已转发',
  };
  const buyXGetYDesc = `订单内商品每满${template.minQuantity || 3}件，自动减${template.value || 1}件`;
  return {
    key: data.couponNo,
    couponNo: data.couponNo,
    templateType: data.templateType,
    ruleType: template.ruleType,
    status: statusMap[data.status] || 'disabled',
    recordStatus: data.status,
    type: template.ruleType === 'buy_x_get_y' ? 4 : template.ruleType === 'amount' ? 1 : 2,
    value: template.value || 0,
    base: template.thresholdAmount || 0,
    valueLabel: template.ruleType === 'employee_price' ? '员工价' : '',
    unitLabel: template.ruleType === 'employee_price' ? '' : '',
    tag: statusTextMap[data.status] || '已失效',
    statusText: statusTextMap[data.status] || '已失效',
    canVoid: ['generated', 'claimed'].includes(data.status),
    desc: template.ruleType === 'buy_x_get_y' ? buyXGetYDesc : (template.desc || ''),
    title: data.title || template.title || '优惠券',
    timeLimit: '长期有效',
    currency: template.ruleType === 'discount' ? '' : '¥',
    createdByOpenid: data.createdByOpenid || '',
    rootCouponNo: getCouponRootNo(data),
    parentCouponNo: data.parentCouponNo || '',
    forwardedByOpenid: data.forwardedByOpenid || '',
    forwardedAt: data.forwardedAt || null,
    claimedByOpenid: data.claimedByOpenid || '',
    usedByOpenid: data.usedByOpenid || '',
    orderNo: data.orderNo || '',
    discountAmount: data.discountAmount || '0',
    scopeSpuIds: getScopedSpuIds(template),
    scopeGoods: getScopedGoodsSummary(template),
    scopeGoodsText: getScopedGoodsSummary(template).map((item) => item.title).join('、'),
    scopeType: getScopedSpuIds(template).length ? 'selected_goods' : 'all_goods',
    scopeDisplayText: getScopedSpuIds(template).length
      ? `适用商品：${getScopedGoodsSummary(template).map((item) => item.title).join('、') || '指定商品'}`
      : '适用商品：全场通用',
    createdAt: data.createdAt,
    claimedAt: data.claimedAt,
    usedAt: data.usedAt,
    useNotes: template.ruleType === 'buy_x_get_y'
      ? `订单内商品数量每满${template.minQuantity || 3}件，自动抵扣${template.value || 1}件商品金额；多种商品会一起累计计算。`
      : template.ruleType === 'employee_price'
        ? '仅对已配置员工价的商品生效，下单时按员工价自动抵扣差额。'
        : getScopedSpuIds(template).length
          ? '仅对指定商品生效，下单时自动按命中的商品金额抵扣。'
          : '下单时自动选择可用优惠券并抵扣。',
    storeAdapt: getScopedSpuIds(template).length
      ? `指定商品可用（${getScopedGoodsSummary(template).map((item) => item.title).join('、') || '部分商品'}）`
      : '商城通用',
  };
};

const formatCouponRecordForRequester = async (coupon, openid) => {
  const data = typeof coupon?.toJSON === 'function' ? coupon.toJSON() : coupon || {};
  const isOwner = String(data.claimedByOpenid || '') === String(openid || '');
  const canForward = data.status === 'claimed' && isOwner && await isCouponEmployee(openid);
  return {
    ...formatCouponRecord(coupon),
    canForward,
    forwardHint: canForward ? '您已通过员工身份验证，可继续转发给好友领取。' : '',
  };
};

const parseMoneyToCents = (value) => {
  if (value === null || value === undefined || value === '') return 0;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount);
};

const productPriceToCents = (value) => {
  if (value === null || value === undefined || value === '') return 0;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return Math.round(amount * 100);
};

const getSkuSalePrice = (product = {}, skuId = '') => {
  const skuList = Array.isArray(product.skuList) ? product.skuList : [];
  const matchedSku = skuList.find((sku) => String(sku?.skuId || '') === String(skuId || ''));
  const skuPrice = Number(matchedSku?.priceInfo?.[0]?.price || 0);
  return Number.isFinite(skuPrice) && skuPrice > 0 ? Math.round(skuPrice) : 0;
};

const getProductBasePrice = (product = {}, skuId = '') => (
  getSkuSalePrice(product, skuId)
  || Math.round(Number(product.minSalePrice || 0))
  || productPriceToCents(product.price)
);

const getProductEmployeePrice = (product = {}) => Math.max(parseMoneyToCents(product.employeePrice), 0);

const buildSpecsText = (specInfo = []) => (
  Array.isArray(specInfo)
    ? specInfo.map((item) => item?.specValue).filter(Boolean).join('，')
    : ''
);

const buildPricedGoodsList = async (goodsList = []) => {
  const spuIds = Array.from(new Set(goodsList.map((item) => String(item.spuId || '').trim()).filter(Boolean)));
  const products = spuIds.length
    ? await Product.findAll({ where: { spuId: { [Op.in]: spuIds } } })
    : [];
  const productMap = new Map(products.map((item) => [item.spuId, typeof item.toJSON === 'function' ? item.toJSON() : item]));

  return goodsList.map((item) => {
    const spuId = String(item.spuId || '').trim();
    const skuId = String(item.skuId || '').trim();
    const product = productMap.get(spuId) || {};
    const quantity = Math.max(Number(item.quantity || item.buyQuantity || 1), 1);
    const price = getProductBasePrice(product, skuId)
      || Math.max(Number(item.price || item.settlePrice || item.actualPrice || 0), 0);
    const employeePrice = getProductEmployeePrice(product);
    return {
      storeId: item.storeId || '1',
      storeName: item.storeName || '蓝点荟旗舰店',
      spuId,
      skuId,
      goodsName: item.goodsName || item.title || product.title || '',
      title: item.goodsName || item.title || product.title || '',
      thumb: item.thumb || item.image || item.primaryImage || '',
      image: item.thumb || item.image || item.primaryImage || '',
      quantity,
      price,
      settlePrice: price,
      actualPrice: price,
      employeePrice,
      specs: item.specs || buildSpecsText(item.specInfo || []),
      specInfo: Array.isArray(item.specInfo) ? item.specInfo : [],
      skuSpecLst: Array.isArray(item.specInfo) ? item.specInfo : [],
      tagPrice: null,
      tagText: null,
    };
  });
};

const getRequestedCouponNo = (couponList = [], couponNo = '') => {
  const explicitCouponNo = String(couponNo || '').trim();
  if (explicitCouponNo) return explicitCouponNo;
  if (!Array.isArray(couponList) || !couponList.length) return '';
  const selectedCoupon = couponList.find((item) => item && (item.selected || item.isSelected) && item.couponNo);
  if (selectedCoupon?.couponNo) return String(selectedCoupon.couponNo).trim();
  const firstCoupon = couponList.find((item) => item && item.couponNo);
  return firstCoupon?.couponNo ? String(firstCoupon.couponNo).trim() : '';
};

const getScopedSpuIds = (template = {}) => {
  const scopeSpuIds = Array.isArray(template.meta?.scopeSpuIds)
    ? template.meta.scopeSpuIds
    : Array.isArray(template.scopeSpuIds)
      ? template.scopeSpuIds
      : [];
  return Array.from(new Set(scopeSpuIds.map((item) => String(item || '').trim()).filter(Boolean)));
};

const getScopedGoodsSummary = (template = {}) => {
  const scopeGoods = Array.isArray(template.meta?.scopeGoods)
    ? template.meta.scopeGoods
    : Array.isArray(template.scopeGoods)
      ? template.scopeGoods
      : [];
  return scopeGoods
    .map((item) => ({
      spuId: String(item?.spuId || '').trim(),
      title: String(item?.title || '').trim(),
    }))
    .filter((item) => item.spuId && item.title);
};

const getEligibleGoodsForCoupon = (template = {}, goodsList = []) => {
  const scopeSpuIds = getScopedSpuIds(template);
  if (!scopeSpuIds.length) return goodsList;
  const scopeSet = new Set(scopeSpuIds);
  return goodsList.filter((goods) => scopeSet.has(String(goods.spuId || '').trim()));
};

const buildBuyXGetYGroups = (goodsList = []) => {
  const grouped = new Map();
  goodsList.forEach((goods) => {
    const spuId = String(goods.spuId || '').trim();
    const skuId = String(goods.skuId || '').trim();
    const price = Math.max(Number(goods.price || goods.settlePrice || goods.actualPrice || 0), 0);
    const quantity = Math.max(Number(goods.quantity || goods.buyQuantity || 1), 0);
    if (!quantity || !price) return;
    const key = `${spuId}::${skuId}::${price}`;
    const current = grouped.get(key) || { price, quantity: 0 };
    current.quantity += quantity;
    grouped.set(key, current);
  });
  return Array.from(grouped.values());
};

const calculateBuyXGetYDiscount = (template = {}, goodsList = []) => {
  const minQuantity = Math.max(Number(template.minQuantity || 3), 1);
  const freeQuantity = Math.max(Number(template.value || 1), 1);
  if (freeQuantity >= minQuantity) return 0;

  return buildBuyXGetYGroups(goodsList).reduce((sum, item) => {
    const matchedRounds = Math.floor(item.quantity / minQuantity);
    if (matchedRounds <= 0) return sum;
    return sum + (matchedRounds * freeQuantity * item.price);
  }, 0);
};

const calculateCouponDiscount = (coupon, goodsList = [], totalAmount = 0) => {
  if (!coupon || coupon.status !== 'claimed') return 0;
  const amount = Math.max(Number(totalAmount || 0), 0);
  if (amount <= 0) return 0;
  const template = getCouponTemplateSnapshot(coupon);
  const eligibleGoodsList = getEligibleGoodsForCoupon(template, goodsList);
  const eligibleAmount = eligibleGoodsList.reduce((sum, goods) => {
    const qty = Math.max(Number(goods.quantity || goods.buyQuantity || 1), 0);
    const price = Math.max(Number(goods.price || goods.settlePrice || goods.actualPrice || 0), 0);
    return sum + qty * price;
  }, 0);
  if ((template.ruleType === 'discount' || template.ruleType === 'amount') && eligibleAmount <= 0) return 0;
  if (template.thresholdAmount && amount < template.thresholdAmount) return 0;

  if (template.ruleType === 'discount') {
    if (template.value <= 0 || template.value >= 10) return 0;
    return Math.floor(eligibleAmount * (10 - template.value) / 10);
  }
  if (template.ruleType === 'amount') {
    return Math.min(Math.max(Number(template.value || 0), 0), Math.max(eligibleAmount - 1, 0));
  }
  if (template.ruleType === 'buy_x_get_y') {
    return calculateBuyXGetYDiscount(template, eligibleGoodsList);
  }
  if (template.ruleType === 'employee_price') {
    return goodsList.reduce((sum, goods) => {
      const quantity = Math.max(Number(goods.quantity || goods.buyQuantity || 1), 0);
      const salePrice = Math.max(Number(goods.price || goods.settlePrice || goods.actualPrice || 0), 0);
      const employeePrice = Math.max(Number(goods.employeePrice || 0), 0);
      if (!employeePrice || employeePrice >= salePrice) return sum;
      return sum + (salePrice - employeePrice) * quantity;
    }, 0);
  }
  return 0;
};

const getCouponUnavailableReason = (coupon, goodsList = []) => {
  if (!coupon) return '优惠券不可用';
  const template = getCouponTemplateSnapshot(coupon);
  const eligibleGoodsList = getEligibleGoodsForCoupon(template, goodsList);
  if ((template.ruleType === 'discount' || template.ruleType === 'amount') && !eligibleGoodsList.length) {
    const goodsNames = getScopedGoodsSummary(template).map((item) => item.title);
    return goodsNames.length
      ? `${template.title}仅限指定商品可用：${goodsNames.join('、')}`
      : `${template.title}仅限指定商品可用`;
  }
  if (template.ruleType === 'employee_price') {
    const hasEmployeeGoods = goodsList.some((goods) => {
      const employeePrice = Math.max(Number(goods.employeePrice || 0), 0);
      const salePrice = Math.max(Number(goods.price || goods.settlePrice || goods.actualPrice || 0), 0);
      return employeePrice > 0 && employeePrice < salePrice;
    });
    if (!hasEmployeeGoods) return `${template.title}仅对已配置员工价的商品可用`;
  }
  if (template.ruleType === 'buy_x_get_y') {
    const eligibleTotalQuantity = eligibleGoodsList.reduce(
      (sum, goods) => sum + Math.max(Number(goods.quantity || goods.buyQuantity || 1), 0),
      0,
    );
    if (eligibleTotalQuantity < (template.minQuantity || 3)) {
      return `${template.title}需单个商品满${template.minQuantity || 3}件可用`;
    }
    if (calculateBuyXGetYDiscount(template, eligibleGoodsList) <= 0) {
      return `${template.title}需单个商品达到买赠数量后可用`;
    }
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

const getOrderExpireTime = (order) => {
  const data = order && typeof order.toJSON === 'function' ? order.toJSON() : { ...order };
  const createdAt = new Date(data.createdAt || Date.now()).getTime();
  return createdAt + ORDER_AUTO_CANCEL_MS;
};

const isPendingPaymentOrderExpired = (order, now = Date.now()) => {
  const data = order && typeof order.toJSON === 'function' ? order.toJSON() : { ...order };
  if (Number(data.orderStatus) !== 5) return false;
  if (data.paidAt) return false;
  return getOrderExpireTime(data) <= now;
};

const clearExpiredPendingOrders = async ({ orderNo, orderId } = {}) => {
  const where = {
    orderStatus: 5,
    createdAt: {
      [Op.lte]: new Date(Date.now() - ORDER_AUTO_CANCEL_MS),
    },
  };

  if (orderNo || orderId) {
    const identifiers = [];
    if (orderNo) identifiers.push({ orderNo: String(orderNo).trim() });
    if (orderId && /^\d+$/.test(String(orderId))) identifiers.push({ id: Number(orderId) });
    if (!identifiers.length) return 0;
    where[Op.or] = identifiers;
  }

  // individualHooks 保留每笔订单快照，使删除通知能携带实际订单内容。
  return Order.destroy({ where, individualHooks: true });
};

const startExpiredPendingOrderCleanupTask = () => {
  const runCleanup = async () => {
    try {
      const deletedCount = await clearExpiredPendingOrders();
      if (deletedCount > 0) {
        console.log(`🧹 已删除 ${deletedCount} 条超时未支付订单`);
      }
    } catch (err) {
      console.error('清理超时未支付订单失败:', err.message);
    }
  };

  runCleanup();
  const timer = setInterval(runCleanup, 5 * 60 * 1000);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
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

const USER_AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const USER_AVATAR_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const buildUserAvatarPath = (openid, version = Date.now()) => (
  `/api/user/avatar/${encodeURIComponent(openid)}?v=${encodeURIComponent(version)}`
);

const parseAvatarImage = (imageBase64 = '', mimeType = '') => {
  let payload = String(imageBase64 || '').trim();
  let type = String(mimeType || '').trim().toLowerCase();
  const dataUrlMatch = payload.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i);

  if (dataUrlMatch) {
    type = dataUrlMatch[1].toLowerCase();
    payload = dataUrlMatch[2];
  }

  if (!USER_AVATAR_MIME_TYPES.has(type)) {
    throw new Error('头像仅支持 JPG、PNG 或 WebP 图片');
  }
  if (!payload || !/^[a-zA-Z0-9+/=\s]+$/.test(payload)) {
    throw new Error('头像数据格式异常');
  }

  const imageBuffer = Buffer.from(payload.replace(/\s/g, ''), 'base64');
  if (!imageBuffer.length) {
    throw new Error('头像数据为空');
  }
  if (imageBuffer.length > USER_AVATAR_MAX_BYTES) {
    throw new Error('头像图片不能超过 2MB');
  }

  return {
    mimeType: type,
    imageData: imageBuffer.toString('base64'),
    imageBuffer,
  };
};

const getSalesDisplayName = (profile = {}, fallbackNickName = '') => {
  const data = profile && typeof profile.toJSON === 'function' ? profile.toJSON() : { ...profile };
  return String(data.salesName || fallbackNickName || data.userNickName || '').trim();
};

const formatSalesProfile = (profile, stats = {}) => {
  if (!profile) return null;
  const data = typeof profile.toJSON === 'function' ? profile.toJSON() : profile;
  return {
    openid: data.openid || '',
    salesName: getSalesDisplayName(data),
    userNickName: data.userNickName || '',
    remark: data.remark || '',
    orderCount: Number(stats.orderCount || 0),
    soldQuantity: Number(stats.soldQuantity || 0),
    totalSalesAmount: Number(stats.totalSalesAmount || 0),
    boundUserCount: Number(stats.boundUserCount || 0),
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
  };
};

const buildSalesProfileWithStats = async (salesProfileOrOpenid) => {
  let profile = salesProfileOrOpenid;
  if (!profile) return null;
  if (typeof profile === 'string') {
    profile = await SalesProfile.findOne({ where: { openid: profile } });
  }
  if (!profile) return null;

  const profileOpenid = typeof profile?.toJSON === 'function' ? profile.toJSON().openid : profile.openid;
  const orders = await Order.findAll({
    attributes: ['salesOpenid', 'paymentAmount', 'totalAmount', 'goodsList'],
    where: {
      salesOpenid: profileOpenid,
      orderStatus: { [Op.in]: [10, 40, 50, ORDER_STATUS_RETURNING] },
    },
  });
  const { currentBindingMap } = await buildCurrentBindingsFromSources();
  const bindings = Array.from(currentBindingMap.values()).filter((item) => item.salesOpenid === profileOpenid);
  const statsMap = mergeBindingStatsIntoSalesStatsMap(buildSalesStatsMap(orders), bindings);
  return formatSalesProfile(profile, statsMap.get(profileOpenid));
};

const buildSalesStatsMap = (orders = []) => {
  const map = new Map();
  orders.forEach((order) => {
    const data = typeof order?.toJSON === 'function' ? order.toJSON() : order;
    const salesOpenid = String(data?.salesOpenid || '').trim();
    if (!salesOpenid) return;
    const current = map.get(salesOpenid) || {
      orderCount: 0,
      soldQuantity: 0,
      totalSalesAmount: 0,
    };
    const goodsList = Array.isArray(data.goodsList) ? data.goodsList : [];
    current.orderCount += 1;
    current.soldQuantity += goodsList.reduce(
      (sum, goods) => sum + Math.max(Number(goods.quantity || goods.buyQuantity || 1), 0),
      0,
    );
    current.totalSalesAmount += Math.max(Number(data.paymentAmount || data.totalAmount || 0), 0);
    map.set(salesOpenid, current);
  });
  return map;
};

const mergeBindingStatsIntoSalesStatsMap = (statsMap, bindings = []) => {
  const map = statsMap || new Map();
  bindings.forEach((binding) => {
    const data = typeof binding?.toJSON === 'function' ? binding.toJSON() : binding;
    const salesOpenid = String(data?.salesOpenid || '').trim();
    if (!salesOpenid) return;
    const current = map.get(salesOpenid) || {
      orderCount: 0,
      soldQuantity: 0,
      totalSalesAmount: 0,
      boundUserCount: 0,
    };
    current.orderCount = Number(current.orderCount || 0);
    current.soldQuantity = Number(current.soldQuantity || 0);
    current.totalSalesAmount = Number(current.totalSalesAmount || 0);
    current.boundUserCount = Number(current.boundUserCount || 0) + 1;
    map.set(salesOpenid, current);
  });
  return map;
};

const buildCurrentBindingMap = (bindings = [], bindingRecords = []) => {
  const map = new Map();

  bindings.forEach((binding) => {
    const data = typeof binding?.toJSON === 'function' ? binding.toJSON() : binding;
    const userOpenid = String(data?.userOpenid || '').trim();
    if (!userOpenid) return;
    map.set(userOpenid, {
      userOpenid,
      salesOpenid: String(data?.salesOpenid || '').trim(),
      salesNameSnapshot: String(data?.salesNameSnapshot || '').trim(),
      sourcePage: String(data?.sourcePage || '').trim(),
      sourcePath: String(data?.sourcePath || '').trim(),
      sourceSpuId: String(data?.sourceSpuId || '').trim(),
      boundAt: data?.boundAt || data?.updatedAt || data?.createdAt || null,
      createdAt: data?.createdAt || null,
      updatedAt: data?.updatedAt || null,
    });
  });

  bindingRecords.forEach((record) => {
    const data = typeof record?.toJSON === 'function' ? record.toJSON() : record;
    const userOpenid = String(data?.userOpenid || '').trim();
    if (!userOpenid || map.has(userOpenid)) return;
    map.set(userOpenid, {
      userOpenid,
      salesOpenid: String(data?.salesOpenid || '').trim(),
      salesNameSnapshot: String(data?.salesNameSnapshot || '').trim(),
      sourcePage: String(data?.sourcePage || '').trim(),
      sourcePath: String(data?.sourcePath || '').trim(),
      sourceSpuId: String(data?.sourceSpuId || '').trim(),
      boundAt: data?.boundAt || data?.createdAt || null,
      createdAt: data?.createdAt || null,
      updatedAt: data?.updatedAt || null,
    });
  });

  return map;
};

const buildCurrentBindingsFromSources = async () => {
  const [bindings, bindingRecords] = await Promise.all([
    UserSalesBinding.findAll(),
    UserSalesBindingRecord.findAll({
      order: [['boundAt', 'DESC'], ['createdAt', 'DESC']],
    }),
  ]);
  return {
    currentBindingMap: buildCurrentBindingMap(bindings, bindingRecords),
    bindingRecords,
  };
};

const buildBoundUsersForSales = async (salesOpenid) => {
  const normalizedSalesOpenid = String(salesOpenid || '').trim();
  if (!normalizedSalesOpenid) return [];

  const { currentBindingMap } = await buildCurrentBindingsFromSources();
  const bindings = Array.from(currentBindingMap.values())
    .filter((item) => item.salesOpenid === normalizedSalesOpenid)
    .sort((left, right) => new Date(right.boundAt || 0).getTime() - new Date(left.boundAt || 0).getTime());

  if (!bindings.length) return [];

  const userOpenids = Array.from(new Set(bindings.map((item) => String(item.userOpenid || '').trim()).filter(Boolean)));
  const [users, orders] = await Promise.all([
    User.findAll({
      attributes: ['openid', 'nickName', 'phoneNumber', 'createdAt', 'updatedAt'],
      where: { openid: { [Op.in]: userOpenids } },
    }),
    Order.findAll({
      attributes: ['openid', 'userName', 'createdAt', 'updatedAt'],
      where: {
        openid: { [Op.in]: userOpenids },
        userName: { [Op.ne]: null },
      },
      order: [['createdAt', 'DESC'], ['updatedAt', 'DESC']],
    }),
  ]);

  const userMap = new Map(
    users.map((user) => {
      const data = typeof user?.toJSON === 'function' ? user.toJSON() : user;
      return [String(data?.openid || '').trim(), data];
    }),
  );
  const latestUserNameMap = new Map();
  orders.forEach((order) => {
    const data = typeof order?.toJSON === 'function' ? order.toJSON() : order;
    const userOpenid = String(data?.openid || '').trim();
    const userName = String(data?.userName || '').trim();
    if (!userOpenid || !userName || latestUserNameMap.has(userOpenid)) return;
    latestUserNameMap.set(userOpenid, userName);
  });

  return bindings.map((binding) => {
    const userOpenid = String(binding.userOpenid || '').trim();
    const user = userMap.get(userOpenid) || {};
    return {
      openid: userOpenid,
      nickName: String(user.nickName || '').trim(),
      userName: latestUserNameMap.get(userOpenid) || '',
      phoneNumber: String(user.phoneNumber || '').trim(),
      boundAt: binding.boundAt || null,
      createdAt: user.createdAt || null,
      updatedAt: user.updatedAt || null,
    };
  });
};

const formatUserSalesBinding = (binding) => {
  if (!binding) return null;
  const data = typeof binding.toJSON === 'function' ? binding.toJSON() : binding;
  return {
    userOpenid: data.userOpenid || '',
    salesOpenid: data.salesOpenid || '',
    salesNameSnapshot: data.salesNameSnapshot || '',
    sourcePage: data.sourcePage || '',
    sourcePath: data.sourcePath || '',
    sourceSpuId: data.sourceSpuId || '',
    boundAt: data.boundAt || data.updatedAt || data.createdAt || null,
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
  };
};

const formatUserSalesBindingRecord = (record) => {
  if (!record) return null;
  const data = typeof record.toJSON === 'function' ? record.toJSON() : record;
  return {
    userOpenid: data.userOpenid || '',
    salesOpenid: data.salesOpenid || '',
    salesNameSnapshot: data.salesNameSnapshot || '',
    previousSalesOpenid: data.previousSalesOpenid || '',
    previousSalesNameSnapshot: data.previousSalesNameSnapshot || '',
    sourcePage: data.sourcePage || '',
    sourcePath: data.sourcePath || '',
    sourceSpuId: data.sourceSpuId || '',
    boundAt: data.boundAt || data.createdAt || null,
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
  };
};

const getBoundSalesForUser = async (userOpenid) => {
  const openid = String(userOpenid || '').trim();
  if (!openid || openid === 'local_dev_user') return null;

  const binding = await UserSalesBinding.findOne({ where: { userOpenid: openid } });
  if (!binding) return null;

  const formattedBinding = formatUserSalesBinding(binding);
  const salesProfile = await SalesProfile.findOne({ where: { openid: formattedBinding.salesOpenid } });
  const salesName = salesProfile
    ? getSalesDisplayName(salesProfile, formattedBinding.salesNameSnapshot)
    : formattedBinding.salesNameSnapshot;

  return {
    binding,
    bindingInfo: {
      ...formattedBinding,
      salesNameSnapshot: salesName,
    },
    salesProfile,
    salesOpenid: formattedBinding.salesOpenid,
    salesName,
  };
};

const getRequestOpenid = (req) => String(req.headers['x-wx-openid'] || '').trim() || 'local_dev_user';

const isOwnedByRequester = (recordOpenid, requesterOpenid) => {
  const ownerOpenid = String(recordOpenid || '').trim();
  const currentOpenid = String(requesterOpenid || '').trim() || 'local_dev_user';

  if (!ownerOpenid) return currentOpenid === 'local_dev_user';
  if (currentOpenid === 'local_dev_user') return ownerOpenid === 'local_dev_user';
  return ownerOpenid === currentOpenid;
};

const bindSalesForUser = async ({
  userOpenid,
  salesOpenid,
  sourcePage = '',
  sourcePath = '',
  sourceSpuId = '',
}) => {
  const normalizedUserOpenid = String(userOpenid || '').trim();
  const normalizedSalesOpenid = String(salesOpenid || '').trim();
  if (!normalizedUserOpenid || normalizedUserOpenid === 'local_dev_user') {
    return { bound: false, reason: 'missing-user' };
  }
  if (!normalizedSalesOpenid) {
    return { bound: false, reason: 'missing-sales' };
  }

  const salesProfile = await SalesProfile.findOne({ where: { openid: normalizedSalesOpenid } });
  if (!salesProfile) {
    return { bound: false, reason: 'not-sales' };
  }

  const salesName = getSalesDisplayName(salesProfile) || buildDefaultNickName(normalizedSalesOpenid);
  const now = new Date();
  const existing = await UserSalesBinding.findOne({ where: { userOpenid: normalizedUserOpenid } });
  const previousInfo = existing ? formatUserSalesBinding(existing) : null;

  await UserSalesBinding.upsert({
    userOpenid: normalizedUserOpenid,
    salesOpenid: normalizedSalesOpenid,
    salesNameSnapshot: salesName,
    sourcePage: String(sourcePage || '').trim(),
    sourcePath: String(sourcePath || '').trim(),
    sourceSpuId: String(sourceSpuId || '').trim(),
    boundAt: now,
  });

  await UserSalesBindingRecord.create({
    userOpenid: normalizedUserOpenid,
    salesOpenid: normalizedSalesOpenid,
    salesNameSnapshot: salesName,
    previousSalesOpenid: previousInfo?.salesOpenid || null,
    previousSalesNameSnapshot: previousInfo?.salesNameSnapshot || '',
    sourcePage: String(sourcePage || '').trim(),
    sourcePath: String(sourcePath || '').trim(),
    sourceSpuId: String(sourceSpuId || '').trim(),
    boundAt: now,
  });

  return {
    bound: true,
    salesOpenid: normalizedSalesOpenid,
    salesName,
    previousSalesOpenid: previousInfo?.salesOpenid || '',
    previousSalesName: previousInfo?.salesNameSnapshot || '',
    boundAt: now,
  };
};

const saveHomeAsset = async (req, res) => {
  try {
    const assetKey = String(req.params.key || '').trim();
    if (!validateAssetKey(assetKey)) {
      return res.send({ code: -1, message: '无效的资源 key' });
    }

    const { label, url, fileName, imageUrl, content } = req.body || {};
    const assetFile = String(fileName || imageUrl || url || '').trim();
    const assetContent = String(content || '').trim();
    const preset = HOME_ASSET_DEFINITIONS.find((item) => item.key === assetKey);
    if (!assetFile && !assetContent) {
      return res.send({ code: -1, message: '请提供 url、imageUrl、fileName 或 content' });
    }

    await HomeAsset.upsert({
      assetKey,
      label: String(label || preset?.label || assetKey).trim(),
      url: assetFile,
      content: assetContent,
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

const isOnlyPaymentOrder = (order) => {
  const data = typeof order?.toJSON === 'function' ? order.toJSON() : (order || {});
  if (typeof data.isOnlyPayment === 'boolean') return data.isOnlyPayment;
  return !data.userAddress;
};

const markOrderPaid = async (order, transactionId, paidAt) => {
  const nextTrajectory = mergeTrajectory(order.trajectoryVos || [], 200002);
  const onlyPayment = isOnlyPaymentOrder(order);

  await order.update({
    orderStatus: onlyPayment ? 50 : 10,
    orderStatusName: onlyPayment ? '交易完成' : '待发货',
    transactionId: transactionId || order.transactionId || 'CLIENT_CONFIRMED',
    paidAt: paidAt || order.paidAt || new Date(),
    trajectoryVos: nextTrajectory,
  });

  return order;
};

const buildLogisticsVO = (address = {}, order = {}) => {
  const receiverAddress = address.detailAddress || address.address || '';
  const hasReceiver = !!(address.name || address.phone || address.phoneNumber || receiverAddress);
  return {
    logisticsType: hasReceiver ? 1 : 0,
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
    buttonVOs: Number(data.orderStatus) === ORDER_STATUS_RETURNING
      ? [{ primary: false, type: 10, name: '取消退货' }]
      : hasActiveAfterSale ? [{ primary: false, type: 5, name: '查看售后' }] : getOrderButtons(data.orderStatus),
    labelVOs: null,
    invoiceVO: null,
    couponAmount: String(data.couponAmount || '0'),
    couponNo: data.couponNo || '',
    couponSnapshot: data.couponSnapshot || null,
    salesOpenid: data.salesOpenid || '',
    salesNameSnapshot: data.salesNameSnapshot || '',
    salesName: data.salesNameSnapshot || '',
    isOnlyPayment: isOnlyPaymentOrder(data),
    autoCancelTime: createTime + ORDER_AUTO_CANCEL_MS,
    orderStatusName: displayStatusName,
    orderStatusRemark:
      Number(data.orderStatus) === 5
        ? `需支付￥${(Number(data.paymentAmount || data.totalAmount || 0) / 100).toFixed(2)}`
        : Number(data.orderStatus) === 50
          ? '订单已完成，无需填写物流信息'
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

const getWechatPhoneNumberByCode = async (code) => {
  const normalizedCode = String(code || '').trim();
  if (!normalizedCode) {
    throw new Error('缺少手机号授权 code');
  }

  const accessToken = await getWechatAccessToken();
  if (!accessToken) {
    throw new Error('缺少微信 access_token 配置');
  }

  const result = await requestWechatJson({
    method: 'POST',
    path: `/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(accessToken)}`,
    data: { code: normalizedCode },
  });

  if (result.errcode) {
    throw new Error(result.errmsg || `获取手机号失败：${result.errcode}`);
  }

  const phoneInfo = result.phone_info || {};
  const phoneNumber = String(phoneInfo.purePhoneNumber || phoneInfo.phoneNumber || '').trim();
  if (!phoneNumber) {
    throw new Error('微信未返回手机号');
  }

  return {
    phoneNumber,
    countryCode: String(phoneInfo.countryCode || '').trim(),
    watermark: phoneInfo.watermark || null,
  };
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
  200002: {
    code: '200002',
    title: '支付成功',
    status: '订单已完成支付',
    orderStatus: 10,
    orderStatusName: '待发货',
  },
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
  const isClosed =
    Number(data.rightsStatus) === AFTER_SERVICE_STATUS.CLOSED ||
    Number(data.userRightsStatus) === SERVICE_STATUS.CLOSED;
  const isRefunded = Number(data.userRightsStatus) === SERVICE_STATUS.REFUNDED;
  const userRightsStatusName =
    isClosed
      ? '已关闭'
      : isRefunded
      ? '已退款'
      : hasLogisticsNo
        ? '买家已寄出'
        : isReturnGoods
          ? '待买家退货'
          : '待商家处理';
  const userRightsStatusDesc =
    isClosed
      ? '退货/售后申请已取消'
      : isRefunded
      ? '退款/售后已完成'
      : hasLogisticsNo
        ? '退货物流已提交，商家将尽快收货处理'
        : isReturnGoods
          ? '商家已同意退货，请使用微信退货或填写退货运单'
          : '商家将尽快确认您的退款申请';
  const canCancel = !isClosed && !isRefunded;
  const buttonVOs = [];

  if (canCancel) {
    buttonVOs.push({ name: isReturnGoods ? '取消退货' : '撤销售后', primary: false, type: 2 });
  }

  if (isReturnGoods && canCancel && !hasLogisticsNo) {
    buttonVOs.push({ name: '填写运单号', primary: true, type: 3 });
  } else if (isReturnGoods && canCancel && hasLogisticsNo) {
    buttonVOs.push(
      { name: '修改运单号', primary: false, type: 4 },
      { name: '查看物流', primary: false, type: 5 },
    );
  }

  return {
    buttonVOs,
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

const ORDER_STATUS_NAMES = {
  5: '待付款',
  10: '待发货',
  40: '待收货',
  50: '交易完成',
  [ORDER_STATUS_RETURNING]: '退货中',
  [ORDER_STATUS_REFUNDED]: '已退款',
};

const getReturnStatusSnapshot = (order) => ({
  returnPreviousOrderStatus: Number(order.orderStatus),
  returnPreviousOrderStatusName: order.orderStatusName || ORDER_STATUS_NAMES[Number(order.orderStatus)] || '',
});

const resolveReturnCanceledOrderStatus = (order) => {
  const previousStatus = order.returnPreviousOrderStatus;
  const hasValidPreviousStatus = previousStatus !== null
    && previousStatus !== undefined
    && previousStatus !== ''
    && ![ORDER_STATUS_RETURNING, ORDER_STATUS_REFUNDED].includes(Number(previousStatus));

  if (hasValidPreviousStatus) {
    return {
      orderStatus: Number(previousStatus),
      orderStatusName: order.returnPreviousOrderStatusName || ORDER_STATUS_NAMES[Number(previousStatus)] || '',
      returnPreviousOrderStatus: null,
      returnPreviousOrderStatusName: '',
    };
  }

  // 兼容上线前已处于退货中的历史订单：当时没有保存原状态，只能按物流信息推断。
  return order.logisticsNo || order.waybillToken
    ? { orderStatus: 40, orderStatusName: '待收货', returnPreviousOrderStatus: null, returnPreviousOrderStatusName: '' }
    : { orderStatus: 10, orderStatusName: '待发货', returnPreviousOrderStatus: null, returnPreviousOrderStatusName: '' };
};

const cancelAfterSaleApplication = async (afterSale, { restoreOrderStatus = true } = {}) => {
  if (Number(afterSale.userRightsStatus) === SERVICE_STATUS.REFUNDED) {
    throw new Error('已退款售后不能取消');
  }

  if (Number(afterSale.rightsStatus) !== AFTER_SERVICE_STATUS.CLOSED) {
    await afterSale.update({
      rightsStatus: AFTER_SERVICE_STATUS.CLOSED,
      userRightsStatus: SERVICE_STATUS.CLOSED,
    });
  }

  if (!restoreOrderStatus) return afterSale;

  const order = await Order.findOne({ where: { orderNo: afterSale.orderNo } });
  if (order && Number(order.orderStatus) === ORDER_STATUS_RETURNING) {
    await order.update(resolveReturnCanceledOrderStatus(order));
  }

  return afterSale;
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

app.get('/admin-order-export.js', (req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'admin-order-export.js'));
});

const adminAuth = createAdminAuth({ AdminAccount });

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
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.get('/admin/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin/orders', (req, res) => {
  res.sendFile(path.join(__dirname, 'orders.html'));
});

app.get('/admin/order/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'order-detail.html'));
});

app.get('/admin/coupons', (req, res) => {
  res.sendFile(path.join(__dirname, 'coupons.html'));
});

app.get('/admin/products', (req, res) => {
  res.sendFile(path.join(__dirname, 'products.html'));
});

app.get('/admin/bindings', (req, res) => {
  res.sendFile(path.join(__dirname, 'bindings.html'));
});

app.get('/admin/sales', (req, res) => {
  res.sendFile(path.join(__dirname, 'sales.html'));
});
registerAdminAuthRoutes({ app, AdminAccount, adminAuth });

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

    const boundSales = await getBoundSalesForUser(openid);
    const currentSalesProfile = await buildSalesProfileWithStats(openid);
    const formattedUserInfo = formatUserInfo(user);

    res.send({
      code: 0,
      data: {
        userInfo: {
          ...formattedUserInfo,
          isSales: !!currentSalesProfile,
          salesRoleLabel: currentSalesProfile ? '渠道代理' : '',
          salesName: currentSalesProfile?.salesName || '',
          salesProfile: currentSalesProfile || null,
        },
        isNewUser: created,
        boundSales: boundSales?.bindingInfo || null,
      },
    });
  } catch (err) {
    console.error('自动登录失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

app.get('/api/user/sales-profile', async (req, res) => {
  try {
    const openid = getRequestOpenid(req);
    const salesProfile = await buildSalesProfileWithStats(openid);
    res.send({
      code: 0,
      data: {
        isSales: !!salesProfile,
        salesRoleLabel: salesProfile ? '渠道代理' : '',
        profile: salesProfile,
      },
    });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.get('/api/user/avatar/:openid', async (req, res) => {
  try {
    const openid = String(req.params.openid || '').trim();
    const avatar = await UserAvatar.findOne({ where: { openid } });
    if (!avatar) return res.redirect(DEFAULT_USER_AVATAR);

    const imageBuffer = Buffer.from(avatar.imageData || '', 'base64');
    if (!imageBuffer.length) return res.redirect(DEFAULT_USER_AVATAR);

    res.setHeader('Content-Type', avatar.mimeType || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(imageBuffer);
  } catch (err) {
    console.error('读取用户头像失败:', err);
    return res.redirect(DEFAULT_USER_AVATAR);
  }
});

app.post('/api/user/avatar', async (req, res) => {
  try {
    const openid = getRequestOpenid(req);
    const { imageBase64, mimeType } = req.body || {};
    const avatarImage = parseAvatarImage(imageBase64, mimeType);

    await UserAvatar.upsert({
      openid,
      mimeType: avatarImage.mimeType,
      imageData: avatarImage.imageData,
    });

    const avatarUrl = buildUserAvatarPath(openid);
    const [user] = await User.findOrCreate({
      where: { openid },
      defaults: {
        openid,
        nickName: buildDefaultNickName(openid),
        avatarUrl,
        phoneNumber: '',
        gender: 0,
      },
    });
    await user.update({ avatarUrl });

    res.send({
      code: 0,
      data: {
        userInfo: formatUserInfo(user),
      },
    });
  } catch (err) {
    console.error('更新用户头像失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/user/profile', async (req, res) => {
  try {
    const openid = getRequestOpenid(req);
    const hasNickName = Object.prototype.hasOwnProperty.call(req.body || {}, 'nickName');
    const hasAvatarUrl = Object.prototype.hasOwnProperty.call(req.body || {}, 'avatarUrl');
    const rawNickName = String(req.body?.nickName || '');
    const nickName = rawNickName.trim();
    const avatarUrl = String(req.body?.avatarUrl || '').trim();

    if (!hasNickName && !hasAvatarUrl) {
      res.send({ code: -1, message: '请提供要更新的资料' });
      return;
    }
    if (hasNickName && !nickName) {
      res.send({ code: -1, message: '昵称不能为空' });
      return;
    }
    if (hasNickName && Array.from(nickName).length > 15) {
      res.send({ code: -1, message: '昵称最多15个字' });
      return;
    }

    const [user] = await User.findOrCreate({
      where: { openid },
      defaults: {
        openid,
        nickName: nickName || buildDefaultNickName(openid),
        avatarUrl: avatarUrl || DEFAULT_USER_AVATAR,
        phoneNumber: '',
        gender: 0,
      },
    });

    const updatePayload = {
      updatedAt: new Date(),
    };
    if (hasNickName && user.nickName !== nickName) {
      updatePayload.nickName = nickName;
    }
    if (hasAvatarUrl && avatarUrl && user.avatarUrl !== avatarUrl) {
      updatePayload.avatarUrl = avatarUrl;
    }
    await user.update(updatePayload);

    if (hasNickName) {
      await SalesProfile.update(
        { userNickName: nickName },
        { where: { openid } },
      );
    }

    res.send({
      code: 0,
      data: {
        userInfo: formatUserInfo(user),
      },
    });
  } catch (err) {
    console.error('更新用户资料失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/user/phone-login', async (req, res) => {
  try {
    const headerOpenid = String(req.headers['x-wx-openid'] || '').trim();
    const authorizationCode = String(req.body?.authorizationCode || '').trim();
    const phoneCode = String(req.body?.code || '').trim();
    const codeOpenid = await getOpenidByCode(authorizationCode);
    const openid = headerOpenid || codeOpenid || 'local_dev_user';

    if (!phoneCode) {
      res.send({ code: -1, message: '请先授权手机号' });
      return;
    }

    const phoneInfo = await getWechatPhoneNumberByCode(phoneCode);
    const [user] = await User.findOrCreate({
      where: { openid },
      defaults: {
        openid,
        nickName: buildDefaultNickName(openid),
        avatarUrl: DEFAULT_USER_AVATAR,
        phoneNumber: phoneInfo.phoneNumber,
        gender: 0,
      },
    });

    await user.update({
      phoneNumber: phoneInfo.phoneNumber,
      updatedAt: new Date(),
    });

    const currentSalesProfile = await buildSalesProfileWithStats(openid);
    res.send({
      code: 0,
      data: {
        userInfo: {
          ...formatUserInfo(user),
          phoneNumber: phoneInfo.phoneNumber,
          isSales: !!currentSalesProfile,
          salesRoleLabel: currentSalesProfile ? '渠道代理' : '',
          salesName: currentSalesProfile?.salesName || '',
          salesProfile: currentSalesProfile || null,
        },
      },
    });
  } catch (err) {
    console.error('手机号登录失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/user/sales/bind', async (req, res) => {
  try {
    const headerOpenid = req.headers['x-wx-openid'] || '';
    const {
      authorizationCode,
      salesOpenid,
      sourcePage = '',
      sourcePath = '',
      sourceSpuId = '',
    } = req.body || {};
    const codeOpenid = await getOpenidByCode(authorizationCode);
    const userOpenid = headerOpenid || codeOpenid || 'local_dev_user';

    const result = await bindSalesForUser({
      userOpenid,
      salesOpenid,
      sourcePage,
      sourcePath,
      sourceSpuId,
    });

    res.send({ code: 0, data: result });
  } catch (err) {
    console.error('绑定销售失败:', err);
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
    const scopeSpuIds = Array.isArray(req.body?.scopeSpuIds)
      ? Array.from(new Set(req.body.scopeSpuIds.map((item) => String(item || '').trim()).filter(Boolean)))
      : [];
    let scopeGoods = [];
    if (template.ruleType === 'discount' && scopeSpuIds.length) {
      const products = await Product.findAll({
        where: { spuId: { [Op.in]: scopeSpuIds } },
        attributes: ['spuId', 'title'],
      });
      scopeGoods = products.map((item) => {
        const data = typeof item.toJSON === 'function' ? item.toJSON() : item;
        return { spuId: data.spuId, title: data.title };
      });
      if (!scopeGoods.length) {
        return res.send({ code: -1, message: '所选适用商品不存在' });
      }
    }

    const couponNo = buildCouponNo();
    const coupon = await CouponRecord.create({
      couponNo,
      templateType: template.templateType,
      title: template.title,
      status: 'generated',
      createdByOpenid: openid,
      rootCouponNo: couponNo,
      meta: {
        ...template,
        scopeSpuIds,
        scopeGoods,
      },
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
      where: {
        status: 1,
        templateType: { [Op.in]: DEFAULT_COUPON_TEMPLATES.map((item) => item.templateType) },
      },
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

    const coupons = await CouponRecord.findAll({
      where: { createdByOpenid: openid },
      order: [['createdAt', 'DESC']],
    });
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

    const coupon = await CouponRecord.findOne({ where: { couponNo, createdByOpenid: openid } });
    if (!coupon) return res.send({ code: -1, message: '优惠券不存在，或无权操作其他管理员生成的优惠券' });
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
    const detail = formatCouponRecord(coupon);
    // 分享页只展示券规则，不能泄露领取人或核销订单信息。
    delete detail.claimedByOpenid;
    delete detail.usedByOpenid;
    delete detail.orderNo;
    delete detail.discountAmount;
    delete detail.claimedAt;
    delete detail.usedAt;
    res.send({ code: 0, data: detail });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.get('/api/coupon/my/detail/:couponNo', async (req, res) => {
  try {
    const openid = req.headers['x-wx-openid'] || 'local_dev_user';
    const coupon = await CouponRecord.findOne({
      where: { couponNo: req.params.couponNo, claimedByOpenid: openid },
    });
    if (!coupon) return res.send({ code: -1, message: '优惠券不存在或不属于当前用户' });
    res.send({ code: 0, data: await formatCouponRecordForRequester(coupon, openid) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/coupon/share', async (req, res) => {
  try {
    const openid = req.headers['x-wx-openid'] || 'local_dev_user';
    const couponNo = String(req.body?.couponNo || '').trim();
    if (!couponNo) return res.send({ code: -1, message: '缺少优惠券编号' });

    const coupon = await CouponRecord.findOne({ where: { couponNo } });
    if (!coupon) return res.send({ code: -1, message: '优惠券不存在' });

    if (coupon.status === 'generated') {
      if (coupon.createdByOpenid !== openid) {
        return res.send({ code: -1, message: '无权操作其他优惠券管理员生成的优惠券' });
      }
      if (coupon.parentCouponNo) {
        return res.send({ code: -1, message: '请等待接收人领取后再继续转发' });
      }
      if (!(await isCouponAdmin(openid))) {
        return res.send({ code: -1, message: '仅优惠券管理员可以发起首次转发' });
      }

      const existingShare = await CouponShareRecord.findOne({
        where: { couponNo, recipientOpenid: null },
        order: [['createdAt', 'DESC']],
      });
      const share = existingShare || await CouponShareRecord.create({
        shareId: buildCouponShareId(),
        couponNo,
        rootCouponNo: getCouponRootNo(coupon),
        parentCouponNo: null,
        sharerOpenid: openid,
        sharerRole: 'admin',
      });
      return res.send({
        code: 0,
        data: { couponNo, shareId: share.shareId, shareRole: 'admin' },
      });
    }

    if (coupon.status !== 'claimed' || coupon.claimedByOpenid !== openid) {
      return res.send({ code: -1, message: '只有已领取该优惠券的用户可以继续转发' });
    }
    if (!(await isCouponEmployee(openid))) {
      return res.send({ code: -1, message: '当前用户不是员工身份，领取后不能继续转发' });
    }

    // 员工继续转发属于权益交接：原券立即失效，避免同一权益被持有人和接收人同时使用。
    const { childCoupon, share } = await CouponRecord.sequelize.transaction(async (transaction) => {
      const childCouponNo = buildCouponNo();
      const childCoupon = await CouponRecord.create({
        couponNo: childCouponNo,
        templateType: coupon.templateType,
        title: coupon.title,
        status: 'generated',
        createdByOpenid: coupon.createdByOpenid,
        rootCouponNo: getCouponRootNo(coupon),
        parentCouponNo: coupon.couponNo,
        forwardedByOpenid: openid,
        forwardedAt: new Date(),
        meta: coupon.meta || {},
      }, { transaction });
      const [updatedCount] = await CouponRecord.update({
        status: 'forwarded',
        forwardedByOpenid: openid,
        forwardedAt: new Date(),
        meta: {
          ...(coupon.meta || {}),
          forwardedToCouponNo: childCouponNo,
        },
      }, {
        where: { couponNo, status: 'claimed', claimedByOpenid: openid },
        transaction,
      });
      if (!updatedCount) {
        throw new Error('优惠券状态已变更，请刷新后重试');
      }
      const share = await CouponShareRecord.create({
        shareId: buildCouponShareId(),
        couponNo: childCoupon.couponNo,
        rootCouponNo: getCouponRootNo(coupon),
        parentCouponNo: coupon.couponNo,
        sharerOpenid: openid,
        sharerRole: 'employee',
      }, { transaction });
      return { childCoupon, share };
    });
    res.send({
      code: 0,
      data: { couponNo: childCoupon.couponNo, shareId: share.shareId, shareRole: 'employee' },
    });
  } catch (err) {
    console.error('生成优惠券转发链接失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/coupon/claim', async (req, res) => {
  try {
    const openid = req.headers['x-wx-openid'] || 'local_dev_user';
    const couponNo = String(req.body?.couponNo || '').trim();
    const shareId = String(req.body?.shareId || '').trim();
    if (!couponNo) return res.send({ code: -1, message: '缺少优惠券编号' });

    const coupon = await CouponRecord.findOne({ where: { couponNo } });
    if (!coupon) return res.send({ code: -1, message: '优惠券不存在' });
    let shareRecord = null;
    if (shareId) {
      shareRecord = await CouponShareRecord.findOne({ where: { shareId, couponNo } });
      if (!shareRecord) return res.send({ code: -1, message: '优惠券分享链接无效' });
      if (shareRecord.recipientOpenid && shareRecord.recipientOpenid !== openid) {
        return res.send({ code: -1, message: '该优惠券已被其他用户领取' });
      }
    } else {
      const pendingShare = await CouponShareRecord.findOne({
        where: { couponNo, recipientOpenid: null },
      });
      if (pendingShare) return res.send({ code: -1, message: '请通过有效的优惠券分享链接领取' });
    }
    if (coupon.status === 'used') return res.send({ code: -1, message: '优惠券已核销' });
    if (coupon.status === 'forwarded') return res.send({ code: -1, message: '优惠券已转发给下一位用户' });
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

    if (shareRecord && !shareRecord.recipientOpenid) {
      await shareRecord.update({ recipientOpenid: openid, claimedAt: new Date() });
    }

    res.send({ code: 0, data: await formatCouponRecordForRequester(coupon, openid) });
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

app.get('/api/admin/coupon-share-records', adminAuth, async (req, res) => {
  try {
    const shareRecords = await CouponShareRecord.findAll({ order: [['createdAt', 'DESC']], limit: 500 });
    const couponNos = Array.from(new Set(shareRecords.map((item) => item.couponNo).filter(Boolean)));
    const coupons = couponNos.length
      ? await CouponRecord.findAll({ where: { couponNo: { [Op.in]: couponNos } } })
      : [];
    const couponMap = new Map(coupons.map((item) => [item.couponNo, item]));
    const openids = Array.from(new Set(shareRecords.flatMap((item) => [item.sharerOpenid, item.recipientOpenid]).filter(Boolean)));
    const users = openids.length
      ? await User.findAll({ attributes: ['openid', 'nickName', 'phoneNumber'], where: { openid: { [Op.in]: openids } } })
      : [];
    const userMap = new Map(users.map((item) => [item.openid, item]));

    res.send({
      code: 0,
      data: shareRecords.map((record) => {
        const coupon = couponMap.get(record.couponNo);
        const sharer = userMap.get(record.sharerOpenid);
        const recipient = userMap.get(record.recipientOpenid);
        return {
          shareId: record.shareId,
          couponNo: record.couponNo,
          rootCouponNo: record.rootCouponNo,
          parentCouponNo: record.parentCouponNo || '',
          sharerOpenid: record.sharerOpenid,
          sharerName: sharer?.nickName || '',
          sharerRole: record.sharerRole,
          recipientOpenid: record.recipientOpenid || '',
          recipientName: recipient?.nickName || '',
          recipientPhoneNumber: recipient?.phoneNumber || '',
          sharedAt: record.createdAt,
          claimedAt: record.claimedAt || null,
          couponStatus: coupon?.status || 'deleted',
          usedByOpenid: coupon?.usedByOpenid || '',
          orderNo: coupon?.orderNo || '',
          usedAt: coupon?.usedAt || null,
          discountAmount: coupon?.discountAmount || '0',
        };
      }),
    });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.get('/api/admin/coupon-templates', adminAuth, async (req, res) => {
  try {
    await ensureDefaultCouponTemplates();
    const templates = await CouponTemplate.findAll({
      where: {
        templateType: { [Op.in]: DEFAULT_COUPON_TEMPLATES.map((item) => item.templateType) },
      },
      order: [['sort', 'DESC'], ['createdAt', 'ASC']],
    });
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
    if (!['discount', 'amount', 'buy_x_get_y', 'employee_price'].includes(payload.ruleType)) {
      return res.send({ code: -1, message: '规则类型仅支持 discount/amount/buy_x_get_y/employee_price' });
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
    const templates = await CouponTemplate.findAll({
      where: {
        templateType: { [Op.in]: DEFAULT_COUPON_TEMPLATES.map((item) => item.templateType) },
      },
      order: [['sort', 'DESC'], ['createdAt', 'ASC']],
    });
    res.send({ code: 0, data: templates.map(formatCouponTemplate) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.get('/api/admin/products', adminAuth, async (req, res) => {
  try {
    const keyword = String(req.query.keyword || '').trim();
    const where = {};
    if (keyword) {
      where[Op.or] = [
        { title: { [Op.like]: `%${keyword}%` } },
        { brief: { [Op.like]: `%${keyword}%` } },
        { spuId: { [Op.like]: `%${keyword}%` } },
      ];
    }
    const products = await Product.findAll({
      where,
      order: [['sort', 'DESC'], ['createdAt', 'DESC']],
      attributes: ['spuId', 'title', 'brief', 'price', 'minSalePrice', 'employeePrice'],
    });
    const data = products.map((product) => {
      const item = typeof product.toJSON === 'function' ? product.toJSON() : product;
      const salePrice = Math.round(Number(item.minSalePrice || 0)) || productPriceToCents(item.price);
      const employeePrice = Math.max(Number(item.employeePrice || 0), 0);
      return {
        ...item,
        salePrice,
        salePriceText: `¥${(salePrice / 100).toFixed(2)}`,
        employeePrice,
        employeePriceText: employeePrice ? `¥${(employeePrice / 100).toFixed(2)}` : '',
        employeePriceYuan: employeePrice ? (employeePrice / 100).toFixed(2) : '',
      };
    });
    res.send({ code: 0, data });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/admin/products/:spuId', adminAuth, async (req, res) => {
  try {
    const spuId = String(req.params.spuId || '').trim();
    const product = await Product.findOne({ where: { spuId } });
    if (!product) return res.send({ code: -1, message: '商品不存在' });
    const rawEmployeePrice = String(req.body?.employeePrice ?? '').trim();
    let employeePrice = 0;
    if (rawEmployeePrice) {
      const parsed = Number(rawEmployeePrice);
      if (!Number.isFinite(parsed) || parsed < 0) {
        return res.send({ code: -1, message: '员工价格式不正确' });
      }
      employeePrice = Math.round(parsed * 100);
    }
    await product.update({ employeePrice });
    res.send({ code: 0, data: { spuId, employeePrice } });
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

app.get('/api/admin/sales', adminAuth, async (req, res) => {
  try {
    const salesProfiles = await SalesProfile.findAll({ order: [['createdAt', 'DESC']] });
    const orders = await Order.findAll({
      attributes: ['salesOpenid', 'paymentAmount', 'totalAmount', 'goodsList'],
      where: {
        salesOpenid: { [Op.ne]: null },
        orderStatus: { [Op.in]: [10, 40, 50, ORDER_STATUS_RETURNING] },
      },
    });
    const { currentBindingMap } = await buildCurrentBindingsFromSources();
    const bindings = Array.from(currentBindingMap.values());
    const statsMap = mergeBindingStatsIntoSalesStatsMap(buildSalesStatsMap(orders), bindings);
    res.send({
      code: 0,
      data: salesProfiles.map((profile) => formatSalesProfile(profile, statsMap.get(profile.openid))),
    });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.get('/api/admin/sales/:openid/bound-users', adminAuth, async (req, res) => {
  try {
    const openid = String(req.params.openid || '').trim();
    if (!openid) {
      return res.send({ code: -1, message: '缺少销售 openid' });
    }
    const salesProfile = await SalesProfile.findOne({ where: { openid } });
    if (!salesProfile) {
      return res.send({ code: -1, message: '销售不存在' });
    }
    const users = await buildBoundUsersForSales(openid);
    res.send({ code: 0, data: users });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.get('/api/admin/sales/bindings', adminAuth, async (req, res) => {
  try {
    const { currentBindingMap, bindingRecords } = await buildCurrentBindingsFromSources();
    const bindings = Array.from(currentBindingMap.values())
      .sort((left, right) => new Date(right.boundAt || 0).getTime() - new Date(left.boundAt || 0).getTime());
    const records = bindingRecords.slice(0, 200);
    res.send({
      code: 0,
      data: {
        bindings: bindings.map(formatUserSalesBinding),
        records: records.map(formatUserSalesBindingRecord),
      },
    });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.get('/api/admin/latest-users', adminAuth, async (req, res) => {
  try {
    const users = await User.findAll({
      attributes: ['openid', 'nickName', 'avatarUrl', 'phoneNumber', 'updatedAt', 'createdAt', 'latestUsersVisibleAt'],
      where: { latestUsersVisible: true },
      order: [['updatedAt', 'DESC']],
      limit: 5,
    });
    res.send({ code: 0, data: users.map(formatUserInfo).map((user, index) => ({
      ...user,
      updatedAt: users[index].updatedAt,
      createdAt: users[index].createdAt,
      latestUsersVisibleAt: users[index].latestUsersVisibleAt,
    })) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/user/latest-users-visible', async (req, res) => {
  try {
    const openid = String(req.headers['x-wx-openid'] || '').trim();
    if (!openid) {
      return res.send({ code: -1, message: '缺少用户身份，无法登记展示资格' });
    }

    const user = await User.findOne({ where: { openid } });
    if (!user) {
      return res.send({ code: -1, message: '用户不存在，请重新进入小程序后再试' });
    }

    const now = new Date();
    await user.update({
      latestUsersVisible: true,
      latestUsersVisibleAt: now,
    });

    res.send({
      code: 0,
      data: {
        latestUsersVisible: true,
        latestUsersVisibleAt: now,
      },
    });
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

app.post('/api/admin/sales', adminAuth, async (req, res) => {
  try {
    const openid = String(req.body?.openid || '').trim();
    const salesName = String(req.body?.salesName || '').trim();
    const remark = String(req.body?.remark || '').trim();
    if (!openid) return res.send({ code: -1, message: '请填写 openid' });

    const user = await User.findOne({ where: { openid } });
    if (!user) {
      return res.send({ code: -1, message: '该 openid 对应用户不存在，请先让用户登录一次小程序' });
    }

    const finalSalesName = salesName || String(user.nickName || '').trim() || buildDefaultNickName(openid);
    await SalesProfile.upsert({
      openid,
      salesName: finalSalesName,
      userNickName: String(user.nickName || '').trim(),
      remark,
    });

    const salesProfiles = await SalesProfile.findAll({ order: [['createdAt', 'DESC']] });
    const orders = await Order.findAll({
      attributes: ['salesOpenid', 'paymentAmount', 'totalAmount', 'goodsList'],
      where: {
        salesOpenid: { [Op.ne]: null },
        orderStatus: { [Op.in]: [10, 40, 50, ORDER_STATUS_RETURNING] },
      },
    });
    const bindings = await UserSalesBinding.findAll();
    const statsMap = mergeBindingStatsIntoSalesStatsMap(buildSalesStatsMap(orders), bindings);
    res.send({
      code: 0,
      data: salesProfiles.map((profile) => formatSalesProfile(profile, statsMap.get(profile.openid))),
    });
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

app.delete('/api/admin/sales/:openid', adminAuth, async (req, res) => {
  try {
    await SalesProfile.destroy({ where: { openid: req.params.openid } });
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
      { assetKey: 'fullLogo', label: '首页完整品牌 Logo', url: 'fullLogo.png' },
      {
        assetKey: 'aboutDescription',
        label: '首页关于我们文案',
        content: '蓝点荟大健康管理（上海）有限公司是国内领先的科技驱动型健康管理整合平台，致力于通过"检测-干预-管理"全流程闭环，为客户提供全生命周期的精准健康管理服务。平台以肠道微生态调控和心血管早筛为核心切入点，整合全球优质健康科技资源，构建覆盖预防、诊断、干预的一站式解决方案。',
      },
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

app.post('/api/admin/accounts/seed', async (req, res) => {
  try {
    await AdminAccount.destroy({ truncate: true });
    const seedAccounts = buildSeedAdminAccounts();

    await AdminAccount.bulkCreate(seedAccounts);
    res.send({
      code: 0,
      message: '后台账号种子数据初始化成功',
      data: {
        count: seedAccounts.length,
        accounts: seedAccounts.map((item) => ({
          username: item.username,
          roleType: item.roleType,
          displayName: item.displayName,
        })),
      },
    });
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
        'employeePrice',
        'originalPrice',
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

    const prod1 = {
      spuId: 'spu_probiotic_01',
      title: '肠道健康管理益生菌',
      brief: '',
      price: 168,
      badge: '',
      useThumb: true,
      bannerLength: 2,
      detailPicLength: 1,
      sort: 300,
      minSalePrice: 16800,
      maxSalePrice: 16800,
      soldNum: 113,
      spuStockQuantity: 99999,
      isPutOnSale: 1,
      specList: [
        {
          specId: 'spec_01_count',
          title: '规格',
          specValueList: [
            { specValueId: 'package1', specValue: '一份尝试套装', image: '' },
          ],
        },
      ],
      skuList: [
        {
          skuId: 'spu_probiotic_01_sku1',
          pictureSkuId: 'sku1',
          usePicture: true,
          specInfo: [
            { specId: 'spec_01_count', specValueId: 'package1' },
          ],
          priceInfo: [
            { priceType: 1, price: '16800' },
          ],
          stockInfo: { stockQuantity: 9999, safeStockQuantity: 0, soldQuantity: 0 },
        },
      ],
    };
    const prod6 = {
      spuId: 'spu_probiotic_06',
      title: '肠道健康管理益生菌（三份装·8折）',
      brief: '',
      price: 400,
      originalPrice: 504,
      badge: '',
      useThumb: true,
      bannerLength: 2,
      detailPicLength: 1,
      sort: 29,
      minSalePrice: 40000,
      maxSalePrice: 40000,
      maxLinePrice: 50400,
      soldNum: 113,
      spuStockQuantity: 99999,
      isPutOnSale: 1,
      specList: [],
      skuList: [
        {
          skuId: 'spu_probiotic_06_sku1',
          pictureSkuId: 'sku1',
          usePicture: true,
          specInfo: [],
          priceInfo: [
            { priceType: 1, price: '40000' },
            { priceType: 2, price: '50400' },
          ],
          stockInfo: { stockQuantity: 9999, safeStockQuantity: 0, soldQuantity: 0 },
        },
      ],
    };
    const prod2 = {
      spuId: 'spu_probiotic_02',
      title: '肠道菌群检测',
      brief: '',
      price: 899,
      badge: '',
      useThumb: true,
      bannerLength: 2,
      detailPicLength: 1,
      sort: 30,
      minSalePrice: 89900,
      maxSalePrice: 89900,
      maxLinePrice: 99900,
      soldNum: 162,
      spuStockQuantity: 99999,
      isPutOnSale: 1,
      specList: [
      ],
      skuList: [
        {
          skuId: 'spu_probiotic_02_sku1',
          pictureSkuId: 'sku1',
          usePicture: true,
          specInfo: [
            
          ],
          priceInfo: [
            { priceType: 1, price: '89900' },
          ],
          stockInfo: { stockQuantity: 9999, safeStockQuantity: 0, soldQuantity: 0 },
        },
      ],
    };
    const prod3 = {
      spuId: 'spu_probiotic_03',
      title: '体重健康管理益生菌',
      brief: '',
      price: 298,
      badge: '',
      useThumb: true,
      bannerLength: 1,
      detailPicLength: 1,
      sort: 30,
      minSalePrice: 29800,
      maxSalePrice: 29800,
      soldNum: 162,
      spuStockQuantity: 99999,
      isPutOnSale: 1,
      specList: [
      ],
      skuList: [
        {
          skuId: 'spu_probiotic_03_sku1',
          pictureSkuId: 'sku1',
          usePicture: true,
          specInfo: [
            
          ],
          priceInfo: [
            { priceType: 1, price: '29800' },
          ],
          stockInfo: { stockQuantity: 9999, safeStockQuantity: 0, soldQuantity: 0 },
        },
      ],
    };
    const prod4 = {
      spuId: 'spu_probiotic_04',
      title: '情绪健康管理益生菌',
      brief: '',
      price: 168,
      badge: '',
      useThumb: true,
      bannerLength: 3,
      detailPicLength: 1,
      sort: 299,
      minSalePrice: 16800,
      maxSalePrice: 16800,
      soldNum: 271,
      spuStockQuantity: 99999,
      isPutOnSale: 1,
      specList: [
        {
          specId: 'spec_01_count',
          title: '规格',
          specValueList: [
            { specValueId: 'package1', specValue: '一份尝试套装', image: '' },
          ],
        },
      ],
      skuList: [
        {
          skuId: 'spu_probiotic_04_sku1',
          pictureSkuId: 'sku1',
          usePicture: true,
          specInfo: [
            { specId: 'spec_01_count', specValueId: 'package1' },
          ],
          priceInfo: [
            { priceType: 1, price: '16800' },
          ],
          stockInfo: { stockQuantity: 9999, safeStockQuantity: 0, soldQuantity: 0 },
        },
      ],
    };
    const prod7 = {
      spuId: 'spu_probiotic_07',
      title: '情绪健康管理益生菌（三份装·8折）',
      brief: '',
      price: 400,
      originalPrice: 504,
      badge: '',
      useThumb: true,
      bannerLength: 3,
      detailPicLength: 1,
      sort: 0,
      minSalePrice: 40000,
      maxSalePrice: 40000,
      maxLinePrice: 50400,
      soldNum: 271,
      spuStockQuantity: 99999,
      isPutOnSale: 1,
      specList: [],
      skuList: [
        {
          skuId: 'spu_probiotic_07_sku1',
          pictureSkuId: 'sku1',
          usePicture: true,
          specInfo: [],
          priceInfo: [
            { priceType: 1, price: '40000' },
            { priceType: 2, price: '50400' },
          ],
          stockInfo: { stockQuantity: 9999, safeStockQuantity: 0, soldQuantity: 0 },
        },
      ],
    };
    const prod5 = {
      spuId: 'spu_probiotic_05',
      title: '阴道菌群检测',
      brief: '',
      price: 1199,
      badge: '',
      useThumb: true,
      bannerLength: 1,
      detailPicLength: 1,
      sort: 30,
      minSalePrice: 119900,
      maxSalePrice: 119900,
      soldNum: 138,
      spuStockQuantity: 99999,
      isPutOnSale: 1,
      specList: [
      ],
      skuList: [
        {
          skuId: 'spu_probiotic_05_sku1',
          pictureSkuId: 'sku1',
          usePicture: true,
          specInfo: [
            
          ],
          priceInfo: [
            { priceType: 1, price: '119900' },
          ],
          stockInfo: { stockQuantity: 9999, safeStockQuantity: 0, soldQuantity: 0 },
        },
      ],
    };
    const prod8 = {
      spuId: 'spu_probiotic_08',
      title: '肠道菌群检测套装',
      brief: '',
      price: 1788,
      badge: '',
      useThumb: true,
      bannerLength: 1,
      detailPicLength: 1,
      sort: 1,
      minSalePrice: 178800,
      maxSalePrice: 178800,
      soldNum: 102,
      spuStockQuantity: 99999,
      isPutOnSale: 1,
      specList: [
      ],
      skuList: [
        {
          skuId: 'spu_probiotic_05_sku1',
          pictureSkuId: 'sku1',
          usePicture: true,
          specInfo: [
            
          ],
          priceInfo: [
            { priceType: 1, price: '178800' },
          ],
          stockInfo: { stockQuantity: 9999, safeStockQuantity: 0, soldQuantity: 0 },
        },
      ],
    };

    const seedData = [
      prod1,
      prod6,
      prod2,
      prod3,
      prod4,
      prod7,
      prod5,
      prod8,
    ];


    const cloudSeedData = seedData.map((product) =>
      withCloudProductPictures({
        ...product,
      })
    );
    await Product.bulkCreate(cloudSeedData);
    res.send({ code: 0, message: '种子数据初始化成功', data: { count: cloudSeedData.length } });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

const runAllSeeds = async () => {
  const steps = [
    { name: 'products', path: '/api/products/seed' },
    { name: 'adminAccounts', path: '/api/admin/accounts/seed' },
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

  return results;
};

// 初始化全部种子数据（强制重置）：商品 + 后台账号 + 首页资产 + 首页 Banner
app.post('/api/seed', async (req, res) => {
  try {
    const results = await runAllSeeds();
    res.send({ code: 0, message: '全部种子数据初始化成功', data: results });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 更语义化的主路径
app.post('/api/seed/all', async (req, res) => {
  try {
    const results = await runAllSeeds();
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
            storeName: '蓝点荟旗舰店',
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
    const { goodsRequestList = [], couponList = [], couponNo = '' } = req.body;
    const boundSales = await getBoundSalesForUser(openid);
    const pricedGoodsList = await buildPricedGoodsList(goodsRequestList);
    const requestedCouponNo = getRequestedCouponNo(couponList, couponNo);
    const skuDetailVos = pricedGoodsList.map((item) => ({
      storeId: item.storeId,
      spuId: item.spuId,
      skuId: item.skuId,
      goodsName: item.goodsName,
      thumb: item.thumb,
      image: item.image,
      quantity: item.quantity,
      settlePrice: item.price,
      actualPrice: item.price,
      employeePrice: item.employeePrice,
      tagPrice: null,
      tagText: null,
      skuSpecLst: item.skuSpecLst,
    }));

    // 计算总价
    const totalSalePrice = skuDetailVos.reduce((sum, g) => sum + g.quantity * Number(g.settlePrice), 0);
    const totalGoodsCount = skuDetailVos.reduce((sum, g) => sum + g.quantity, 0);
    const couponWhere = { claimedByOpenid: openid, status: 'claimed' };
    if (requestedCouponNo) couponWhere.couponNo = requestedCouponNo;
    const claimedCoupons = await CouponRecord.findAll({
      where: couponWhere,
      order: [['claimedAt', 'ASC'], ['createdAt', 'ASC']],
    });
    const couponCandidates = claimedCoupons.map((coupon) => ({
      coupon,
      amount: calculateCouponDiscount(coupon, skuDetailVos, totalSalePrice),
    }));
    const selectedCoupon = requestedCouponNo
      ? (couponCandidates.find((item) => item.amount > 0) || null)
      : (couponCandidates.find((item) => item.amount > 0) || null);
    const totalCouponAmount = selectedCoupon ? selectedCoupon.amount : 0;
    const totalPayAmount = Math.max(totalSalePrice - totalCouponAmount, 1);
    const settleCouponList = couponCandidates.map(({ coupon, amount }) => {
      const formatted = formatCouponRecord(coupon);
      const isUsable = amount > 0;
      return {
        ...formatted,
        status: isUsable ? formatted.status : 'unavailable',
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
        salesOpenid: boundSales?.salesOpenid || '',
        salesNameSnapshot: boundSales?.salesName || '',
        channelAgentName: boundSales?.salesName || '',
        selectedCoupon: selectedCoupon
          ? { ...formatCouponRecord(selectedCoupon.coupon), discountAmount: String(selectedCoupon.amount) }
          : null,
        storeGoodsList: [
          {
            storeId: '1',
            storeName: '蓝点荟旗舰店',
            storeTotalPayAmount: totalPayAmount,
            skuDetailVos,
            couponList: settleCouponList,
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
    const openid = getRequestOpenid(req);
    const { orderNo, skuId, numOfSku = 1 } = req.query;
    const order = await Order.findOne({ where: { orderNo, openid } });
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
    const openid = getRequestOpenid(req);
    const { rights = {}, rightsItem = [], refundMemo = '' } = req.body || {};
    const order = await Order.findOne({ where: { orderNo: rights.orderNo, openid } });
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
    const openid = getRequestOpenid(req);
    const pageNum = Math.max(Number(req.query.pageNum) || 1, 1);
    const pageSize = Math.max(Number(req.query.pageSize) || 10, 1);
    const afterServiceStatus = req.query.afterServiceStatus;
    const where = { openid };
    if (afterServiceStatus !== undefined && afterServiceStatus !== '' && Number(afterServiceStatus) !== -1) {
      where.rightsStatus = Number(afterServiceStatus);
    }
    const { rows, count } = await AfterSale.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      offset: (pageNum - 1) * pageSize,
      limit: pageSize,
    });
    const allRows = await AfterSale.findAll({ where: { openid } });
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
    const openid = getRequestOpenid(req);
    const afterSale = await AfterSale.findOne({ where: { rightsNo: req.params.rightsNo, openid } });
    if (!afterSale) return res.send({ code: -1, message: '售后单不存在' });
    res.send({ code: 0, data: [formatAfterSaleForMiniProgram(afterSale)] });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

app.post('/api/after-sale/logistics', async (req, res) => {
  try {
    const openid = getRequestOpenid(req);
    const { rightsNo, logisticsCompanyCode, logisticsCompanyName, logisticsNo, remark } = req.body || {};
    const afterSale = await AfterSale.findOne({ where: { rightsNo, openid } });
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
    const openid = getRequestOpenid(req);
    const { rightsNo } = req.body || {};
    const afterSale = await AfterSale.findOne({ where: { rightsNo, openid } });
    if (!afterSale) return res.send({ code: -1, message: '售后单不存在' });
    await cancelAfterSaleApplication(afterSale);
    res.send({ code: 0, data: formatAfterSaleForMiniProgram(afterSale) });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 客户从订单详情取消退货。管理员手动设置的“退货中”订单可能没有售后单，故按订单处理。
app.post('/api/order/cancel-return', async (req, res) => {
  try {
    const openid = getRequestOpenid(req);
    const orderNo = String(req.body?.orderNo || '').trim();
    if (!orderNo) return res.send({ code: -1, message: '缺少订单号' });

    const order = await Order.findOne({ where: { orderNo, openid } });
    if (!order) return res.send({ code: -1, message: '订单不存在或无权操作' });
    if (Number(order.orderStatus) !== ORDER_STATUS_RETURNING) {
      return res.send({ code: -1, message: '只有退货中订单可以取消退货' });
    }

    const afterSales = await AfterSale.findAll({
      where: {
        orderNo,
        rightsStatus: { [Op.ne]: AFTER_SERVICE_STATUS.CLOSED },
        userRightsStatus: { [Op.ne]: SERVICE_STATUS.REFUNDED },
      },
    });
    await Promise.all(afterSales.map((afterSale) => cancelAfterSaleApplication(afterSale, { restoreOrderStatus: false })));
    await order.update(resolveReturnCanceledOrderStatus(order));
    res.send({
      code: 0,
      data: formatOrderForMiniProgram(order, await fetchAfterSalesForOrder(order.orderNo)),
    });
  } catch (err) {
    console.error('客户取消退货失败:', err);
    res.send({ code: -1, message: err.message });
  }
});

// ============ 订单接口 ============

// 订单列表
app.get('/api/order/list', async (req, res) => {
  try {
    await clearExpiredPendingOrders();
    const openid = getRequestOpenid(req);
    const pageNum = Math.max(Number(req.query.pageNum) || 1, 1);
    const pageSize = Math.max(Number(req.query.pageSize) || 10, 1);
    const orderStatus = req.query.orderStatus;
    const where = { openid };

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
        orderNum:
          status === -1
            ? await Order.count({ where: { openid } })
            : await Order.count({ where: { openid, orderStatus: status } }),
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
    const openid = getRequestOpenid(req);
    const id = req.params.id;
    await clearExpiredPendingOrders({ orderNo: id, orderId: id });
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
    if (!isOwnedByRequester(order.openid, openid)) {
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
    const openid = getRequestOpenid(req);
    const { orderNo, orderId } = req.body || {};
    const conditions = [];
    if (orderNo) conditions.push({ orderNo });
    if (orderId && /^\d+$/.test(String(orderId))) conditions.push({ id: Number(orderId) });
    if (!conditions.length) return res.send({ code: -1, message: '缺少订单标识' });

    const order = await Order.findOne({ where: { [Op.or]: conditions } });
    if (!order) return res.send({ code: -1, message: '订单不存在' });
    if (!isOwnedByRequester(order.openid, openid)) {
      return res.send({ code: -1, message: '订单不存在' });
    }

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
    const openid = getRequestOpenid(req);
    const { orderNo, orderId } = req.body || {};
    const conditions = [];
    if (orderNo) conditions.push({ orderNo });
    if (orderId && /^\d+$/.test(String(orderId))) conditions.push({ id: Number(orderId) });
    if (!conditions.length) return res.send({ code: -1, message: '缺少订单标识' });

    const order = await Order.findOne({ where: { [Op.or]: conditions } });
    if (!order) return res.send({ code: -1, message: '订单不存在' });
    if (!isOwnedByRequester(order.openid, openid)) {
      return res.send({ code: -1, message: '订单不存在' });
    }
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
    await clearExpiredPendingOrders({ orderNo: id, orderId: id });
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
    await clearExpiredPendingOrders();
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
    const customerOpenids = Array.from(new Set(
      rows.map((order) => String(order.openid || '').trim()).filter(Boolean),
    ));
    const [afterSaleMap, users, salesBindings] = await Promise.all([
      fetchAfterSalesForOrders(rows.map((order) => order.orderNo)),
      customerOpenids.length
        ? User.findAll({
            attributes: ['openid', 'phoneNumber'],
            where: { openid: { [Op.in]: customerOpenids } },
          })
        : Promise.resolve([]),
      customerOpenids.length
        ? UserSalesBinding.findAll({ where: { userOpenid: { [Op.in]: customerOpenids } } })
        : Promise.resolve([]),
    ]);
    const userMap = new Map(users.map((user) => [String(user.openid || '').trim(), user]));
    const salesBindingMap = new Map(
      salesBindings.map((binding) => [String(binding.userOpenid || '').trim(), formatUserSalesBinding(binding)]),
    );
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
        orders: rows.map((order) => {
          const data = typeof order.toJSON === 'function' ? order.toJSON() : order;
          const formattedOrder = formatOrderForMiniProgram(order, afterSaleMap[order.orderNo] || []);
          const customerOpenid = String(data.openid || '').trim();
          const customer = userMap.get(customerOpenid);
          const currentBinding = salesBindingMap.get(customerOpenid);
          const address = data.userAddress || {};
          return {
            ...formattedOrder,
            customerOpenid,
            customerPhoneNumber: String(
              customer?.phoneNumber || address.phone || address.phoneNumber || '',
            ).trim(),
            customerSalesName: currentBinding?.salesNameSnapshot || formattedOrder.salesNameSnapshot || '',
            customerSalesOpenid: currentBinding?.salesOpenid || formattedOrder.salesOpenid || '',
          };
        }),
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

app.post('/api/admin/order/delete', adminAuth, async (req, res) => {
  try {
    const { orderNo, confirmation } = req.body || {};
    const normalizedOrderNo = String(orderNo || '').trim();
    if (!normalizedOrderNo) return res.send({ code: -1, message: '请填写订单号' });
    if (String(confirmation || '').trim() !== '确认删除') {
      return res.send({ code: -1, message: '请输入“确认删除”后才能删除订单' });
    }

    const order = await Order.findOne({ where: { orderNo: normalizedOrderNo } });
    if (!order) return res.send({ code: -1, message: '订单不存在或已删除' });
    if (![50, ORDER_STATUS_REFUNDED].includes(Number(order.orderStatus))) {
      return res.send({ code: -1, message: '仅已完成或已退款的历史订单可以删除' });
    }

    const activeAfterSaleCount = await AfterSale.count({
      where: {
        orderNo: normalizedOrderNo,
        rightsStatus: { [Op.ne]: AFTER_SERVICE_STATUS.CLOSED },
        userRightsStatus: { [Op.ne]: SERVICE_STATUS.REFUNDED },
      },
    });
    if (activeAfterSaleCount > 0) {
      return res.send({ code: -1, message: '订单存在进行中的售后，暂时不能删除' });
    }

    // individualHooks 会保留订单快照，并触发企业微信的订单删除通知。
    await order.destroy({ individualHooks: true });
    res.send({ code: 0, message: '订单已删除', data: { orderNo: normalizedOrderNo } });
  } catch (err) {
    console.error('管理端删除订单失败:', err);
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
        ...getReturnStatusSnapshot(order),
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

app.post('/api/admin/order/cancel-return', adminAuth, async (req, res) => {
  try {
    const { orderNo } = req.body || {};
    if (!orderNo) return res.send({ code: -1, message: '请填写订单号' });

    const order = await Order.findOne({ where: { orderNo } });
    if (!order) return res.send({ code: -1, message: '订单不存在' });
    if (Number(order.orderStatus) !== ORDER_STATUS_RETURNING) {
      return res.send({ code: -1, message: '只有退货中订单可以取消退货' });
    }

    const afterSales = await AfterSale.findAll({
      where: {
        orderNo,
        rightsStatus: { [Op.ne]: AFTER_SERVICE_STATUS.CLOSED },
        userRightsStatus: { [Op.ne]: SERVICE_STATUS.REFUNDED },
      },
    });
    await Promise.all(afterSales.map((afterSale) => cancelAfterSaleApplication(afterSale, { restoreOrderStatus: false })));
    await order.update(resolveReturnCanceledOrderStatus(order));

    res.send({
      code: 0,
      message: '已取消退货',
      data: formatOrderForMiniProgram(order, await fetchAfterSalesForOrder(order.orderNo)),
    });
  } catch (err) {
    console.error('管理端取消退货失败:', err);
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
    await clearExpiredPendingOrders();
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
    const pricedGoodsList = await buildPricedGoodsList(goodsList);
    const calcTotal = pricedGoodsList.reduce((sum, g) => sum + (Number(g.price) || 0) * (Number(g.quantity) || 1), 0);
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
        amount: calculateCouponDiscount(coupon, pricedGoodsList, calcTotal),
      }))
      .find((item) => item.amount > 0);
    const couponAmount = selectedCoupon ? selectedCoupon.amount : 0;
    const paymentAmount = Math.max(calcTotal - couponAmount, 1);
    const couponSnapshot = selectedCoupon
      ? { ...formatCouponRecord(selectedCoupon.coupon), discountAmount: String(couponAmount) }
      : null;
    const boundSales = await getBoundSalesForUser(openid);

    const orderNo = 'ORD' + Date.now() + Math.random().toString(36).slice(2, 6);

    const order = await Order.create({
      orderNo,
      openid,
      salesOpenid: boundSales?.salesOpenid || null,
      salesNameSnapshot: boundSales?.salesName || '',
      orderStatus: 5,
      orderStatusName: '待付款',
      totalAmount: String(calcTotal),
      paymentAmount: String(paymentAmount),
      couponNo: selectedCoupon ? selectedCoupon.coupon.couponNo : null,
      couponAmount: String(couponAmount),
      couponSnapshot,
      goodsList: pricedGoodsList, // 完整商品快照（含名称、图片、规格、单价、数量）
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
    if (err.wechatRequestSummary || err.wechatHeaders || err.wechatResult) {
      console.error('微信支付诊断信息:', {
        requestSummary: err.wechatRequestSummary || null,
        wechatHeaders: err.wechatHeaders || null,
        wechatResult: err.wechatResult || null,
      });
    }
    res.send({ code: -1, message: err.message });
  }
});

// 已有待付款订单继续支付
app.post('/api/order/pay', async (req, res) => {
  try {
    const headerOpenid = req.headers['x-wx-openid'] || '';
    const { orderId, orderNo, authorizationCode } = req.body || {};
    await clearExpiredPendingOrders({ orderNo, orderId });
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
      return res.send({ code: -1, message: '订单不存在或已超时删除' });
    }
    if (Number(order.orderStatus) !== 5) {
      return res.send({ code: -1, message: '当前订单状态不可支付' });
    }
    if (isPendingPaymentOrderExpired(order)) {
      await order.destroy();
      return res.send({ code: -1, message: '订单已超时删除，请重新下单' });
    }

    const codeOpenid = await getOpenidByCode(authorizationCode);
    const openid = headerOpenid || codeOpenid || order.openid || 'local_dev_user';
    if (!isOwnedByRequester(order.openid, openid)) {
      return res.send({ code: -1, message: '订单不存在或已超时删除' });
    }
    if ((!order.salesOpenid || !order.salesNameSnapshot) && openid && openid !== 'local_dev_user') {
      const boundSales = await getBoundSalesForUser(openid);
      if (boundSales?.salesOpenid) {
        await order.update({
          salesOpenid: boundSales.salesOpenid,
          salesNameSnapshot: boundSales.salesName,
        });
      }
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
    const openid = getRequestOpenid(req);
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
    if (!isOwnedByRequester(order.openid, openid)) {
      return res.send({ code: -1, message: '订单不存在' });
    }

    if (Number(order.orderStatus) === 5) {
      await markOrderPaid(order, transactionId);
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
      await markOrderPaid(
        order,
        payResult.transaction_id,
        payResult.success_time ? new Date(payResult.success_time) : new Date(),
      );
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
  startExpiredPendingOrderCleanupTask();

  // 本地开发模式下自动插入种子数据（SQLite 内存库每次重启都是空的）
  if (!process.env.MYSQL_ADDRESS) {
    const productCount = await Product.count();
    const adminAccountCount = await AdminAccount.count();
    const assetCount = await HomeAsset.count();
    const bannerCount = await HomeBanner.count();
    if (productCount === 0 || adminAccountCount === 0 || assetCount === 0 || bannerCount === 0) {
      console.log('🌱 本地模式：自动插入种子数据...');
      app.listen(port, () => {
        console.log('启动成功', port);
        if (productCount === 0) {
          postLocalSeed('/api/products/seed', '商品种子数据');
        }
        if (adminAccountCount === 0) {
          postLocalSeed('/api/admin/accounts/seed', '后台账号种子数据');
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
