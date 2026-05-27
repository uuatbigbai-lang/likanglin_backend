const { Sequelize, DataTypes } = require("sequelize");

// 判断是否为本地开发环境（没有 MYSQL_ADDRESS 时使用 SQLite 内存数据库）
const { MYSQL_USERNAME, MYSQL_PASSWORD, MYSQL_ADDRESS = "" } = process.env;
const isLocal = !MYSQL_ADDRESS;
const shouldAlterTables = isLocal || process.env.DB_SYNC_ALTER === "true";

let sequelize;
if (isLocal) {
  console.log("⚡ 本地开发模式：使用 SQLite 内存数据库");
  sequelize = new Sequelize({
    dialect: "sqlite",
    storage: ":memory:",
    logging: false,
  });
} else {
  const [host, port] = MYSQL_ADDRESS.split(":");
  sequelize = new Sequelize("nodejs_demo", MYSQL_USERNAME, MYSQL_PASSWORD, {
    host,
    port,
    dialect: "mysql",
  });
}

// 定义数据模型
const Counter = sequelize.define("Counter", {
  count: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
  },
});

// 用户数据模型
const User = sequelize.define("User", {
  openid: {
    type: DataTypes.STRING(128),
    allowNull: false,
    unique: true,
    comment: "微信用户openid",
  },
  nickName: {
    type: DataTypes.STRING(80),
    allowNull: false,
    comment: "用户昵称",
  },
  avatarUrl: {
    type: DataTypes.STRING(500),
    allowNull: true,
    defaultValue: "",
    comment: "用户头像",
  },
  phoneNumber: {
    type: DataTypes.STRING(30),
    allowNull: true,
    defaultValue: "",
    comment: "手机号",
  },
  gender: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: 0,
    comment: "性别",
  },
});

// 商品数据模型
const Product = sequelize.define("Product", {
  spuId: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true,
    comment: "商品SPU编号",
  },
  title: {
    type: DataTypes.STRING(200),
    allowNull: false,
    comment: "商品名称",
  },
  brief: {
    type: DataTypes.STRING(500),
    allowNull: true,
    comment: "商品简介",
  },
  price: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
    comment: "商品价格",
  },
  badge: {
    type: DataTypes.STRING(50),
    allowNull: true,
    defaultValue: "",
    comment: "商品标签（如人气爆款）",
  },
  status: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
    comment: "状态：1上架 0下架",
  },
  sort: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: "排序权重，越大越靠前",
  },
  // ---- 详情页所需字段 ----
  originalPrice: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: true,
    comment: "划线价/原价",
  },
  useThumb: {
    type: DataTypes.BOOLEAN,
    allowNull: true,
    defaultValue: false,
    comment: "是否使用独立缩略图",
  },
  bannerLength: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: 0,
    comment: "商品轮播图数量",
  },
  detailPicLength: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: 0,
    comment: "商品详情图片数量",
  },
  usePicture: {
    type: DataTypes.BOOLEAN,
    allowNull: true,
    defaultValue: false,
    comment: "是否使用独立SKU图片",
  },
  pictureSpuId: {
    type: DataTypes.STRING(64),
    allowNull: true,
    comment: "复用图片资源的SPU编号，不填则使用自身spuId",
  },
  minSalePrice: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: "最低销售价（单位：分）",
  },
  maxSalePrice: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: "最高销售价（单位：分）",
  },
  maxLinePrice: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: "最高划线价（单位：分）",
  },
  soldNum: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: 0,
    comment: "已售数量",
  },
  spuStockQuantity: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: 0,
    comment: "SPU总库存",
  },
  isPutOnSale: {
    type: DataTypes.INTEGER,
    allowNull: true,
    defaultValue: 1,
    comment: "是否上架 1上架 0下架",
  },
  specList: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: [],
    comment: "商品规格列表JSON",
  },
  skuList: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: [],
    comment: "SKU列表JSON",
  },
});

// 地址数据模型
const Address = sequelize.define("Address", {
  openid: {
    type: DataTypes.STRING(128),
    allowNull: true,
    comment: "用户openid",
  },
  name: {
    type: DataTypes.STRING(50),
    allowNull: false,
    comment: "收货人姓名",
  },
  phone: {
    type: DataTypes.STRING(20),
    allowNull: false,
    comment: "手机号",
  },
  provinceName: {
    type: DataTypes.STRING(50),
    defaultValue: "",
  },
  cityName: {
    type: DataTypes.STRING(50),
    defaultValue: "",
  },
  districtName: {
    type: DataTypes.STRING(50),
    defaultValue: "",
  },
  detailAddress: {
    type: DataTypes.STRING(200),
    defaultValue: "",
  },
  isDefault: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    comment: "是否默认地址",
  },
  addressTag: {
    type: DataTypes.STRING(20),
    defaultValue: "",
    comment: "地址标签（如家、公司）",
  },
});

// 购物车数据模型
const CartItem = sequelize.define("CartItem", {
  openid: {
    type: DataTypes.STRING(128),
    allowNull: true,
    comment: "用户openid",
  },
  spuId: {
    type: DataTypes.STRING(64),
    allowNull: false,
  },
  skuId: {
    type: DataTypes.STRING(64),
    defaultValue: "",
  },
  title: {
    type: DataTypes.STRING(200),
    defaultValue: "",
    comment: "商品名称",
  },
  thumb: {
    type: DataTypes.STRING(500),
    defaultValue: "",
    comment: "缩略图",
  },
  price: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    comment: "单价（分）",
  },
  originPrice: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: "划线价（分）",
  },
  quantity: {
    type: DataTypes.INTEGER,
    defaultValue: 1,
    comment: "加购数量",
  },
  specs: {
    type: DataTypes.STRING(200),
    defaultValue: "",
    comment: "规格描述，如 30条装+原味",
  },
  stockQuantity: {
    type: DataTypes.INTEGER,
    defaultValue: 999,
    comment: "库存数",
  },
  isSelected: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
    comment: "是否选中",
  },
});

// 订单数据模型
const Order = sequelize.define("Order", {
  orderNo: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true,
    comment: "订单编号",
  },
  openid: {
    type: DataTypes.STRING(128),
    allowNull: true,
    comment: "用户openid",
  },
  orderStatus: {
    type: DataTypes.INTEGER,
    defaultValue: 5,
    comment: "订单状态 5待付款 10待发货 40已完成 80已取消",
  },
  orderStatusName: {
    type: DataTypes.STRING(20),
    defaultValue: "待付款",
  },
  totalAmount: {
    type: DataTypes.STRING(20),
    comment: "订单总金额（分）",
  },
  paymentAmount: {
    type: DataTypes.STRING(20),
    comment: "实付金额（分）",
  },
  couponNo: {
    type: DataTypes.STRING(64),
    allowNull: true,
    comment: "使用的优惠券编号",
  },
  couponAmount: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: "0",
    comment: "优惠券抵扣金额（分）",
  },
  couponSnapshot: {
    type: DataTypes.JSON,
    defaultValue: null,
    comment: "下单时优惠券快照",
  },
  goodsList: {
    type: DataTypes.JSON,
    defaultValue: [],
    comment: "商品快照JSON",
  },
  userAddress: {
    type: DataTypes.JSON,
    defaultValue: null,
    comment: "收货地址快照JSON",
  },
  userName: {
    type: DataTypes.STRING(50),
    allowNull: true,
  },
  remark: {
    type: DataTypes.STRING(200),
    defaultValue: "",
    comment: "订单备注",
  },
  prepayId: {
    type: DataTypes.STRING(128),
    allowNull: true,
    comment: "微信支付预支付交易会话标识",
  },
  transactionId: {
    type: DataTypes.STRING(128),
    allowNull: true,
    comment: "微信支付订单号",
  },
  waybillToken: {
    type: DataTypes.STRING(256),
    allowNull: true,
    comment: "微信物流查询插件 waybill_token",
  },
  logisticsNo: {
    type: DataTypes.STRING(128),
    allowNull: true,
    comment: "物流运单号",
  },
  logisticsCompanyCode: {
    type: DataTypes.STRING(64),
    allowNull: true,
    comment: "物流公司编码或运力id",
  },
  logisticsCompanyName: {
    type: DataTypes.STRING(80),
    allowNull: true,
    comment: "物流公司名称",
  },
  trajectoryVos: {
    type: DataTypes.JSON,
    defaultValue: [],
    comment: "订单物流轨迹",
  },
  sampleStatus: {
    type: DataTypes.STRING(32),
    allowNull: true,
    defaultValue: "",
    comment: "检测样本状态 returning/testing/completed",
  },
  paidAt: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: "支付成功时间",
  },
});

const AfterSale = sequelize.define("AfterSale", {
  rightsNo: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true,
    comment: "售后服务单号",
  },
  returnId: {
    type: DataTypes.STRING(128),
    allowNull: true,
    comment: "预留退货外部平台标识",
  },
  orderNo: {
    type: DataTypes.STRING(64),
    allowNull: false,
    comment: "订单编号",
  },
  openid: {
    type: DataTypes.STRING(128),
    allowNull: true,
    comment: "用户openid",
  },
  rightsType: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 20,
    comment: "售后类型 20仅退款 10退货退款",
  },
  rightsStatus: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 10,
    comment: "商家侧售后状态",
  },
  userRightsStatus: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 100,
    comment: "用户侧售后状态",
  },
  refundRequestAmount: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: "0",
    comment: "申请退款金额（分）",
  },
  refundAmount: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: "0",
    comment: "实际退款金额（分）",
  },
  rightsReasonDesc: {
    type: DataTypes.STRING(200),
    defaultValue: "",
    comment: "售后原因",
  },
  rightsReasonType: {
    type: DataTypes.STRING(64),
    defaultValue: "",
    comment: "售后原因类型",
  },
  refundMemo: {
    type: DataTypes.STRING(500),
    defaultValue: "",
    comment: "退款说明",
  },
  rightsImageUrls: {
    type: DataTypes.JSON,
    defaultValue: [],
    comment: "售后凭证图片",
  },
  rightsItems: {
    type: DataTypes.JSON,
    defaultValue: [],
    comment: "售后商品快照",
  },
  logistics: {
    type: DataTypes.JSON,
    defaultValue: {},
    comment: "用户退货物流与商家退货地址",
  },
  wechatReturnPayload: {
    type: DataTypes.JSON,
    defaultValue: null,
    comment: "预留退货外部平台请求体",
  },
});

const AdminWhitelist = sequelize.define("AdminWhitelist", {
  openid: {
    type: DataTypes.STRING(128),
    allowNull: false,
    unique: true,
    comment: "可管理优惠券的微信用户openid",
  },
  remark: {
    type: DataTypes.STRING(100),
    allowNull: true,
    defaultValue: "",
    comment: "备注",
  },
});

const CouponTemplate = sequelize.define("CouponTemplate", {
  templateType: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true,
    comment: "优惠券模板唯一标识",
  },
  title: {
    type: DataTypes.STRING(80),
    allowNull: false,
    comment: "优惠券标题",
  },
  ruleType: {
    type: DataTypes.STRING(32),
    allowNull: false,
    defaultValue: "discount",
    comment: "规则类型 discount/amount/buy_x_get_y",
  },
  value: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: "折扣值/减免金额/赠送件数，折扣券如9表示9折",
  },
  thresholdAmount: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: "最低订单金额门槛（分）",
  },
  minQuantity: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: "最低商品件数门槛",
  },
  desc: {
    type: DataTypes.STRING(300),
    allowNull: true,
    defaultValue: "",
    comment: "规则说明",
  },
  status: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
    comment: "状态：1启用 0停用",
  },
  sort: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
    comment: "排序权重，越大越靠前",
  },
  meta: {
    type: DataTypes.JSON,
    defaultValue: {},
    comment: "扩展规则配置",
  },
});

const CouponRecord = sequelize.define("CouponRecord", {
  couponNo: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true,
    comment: "优惠券编号",
  },
  templateType: {
    type: DataTypes.STRING(32),
    allowNull: false,
    comment: "nine折券/seven折券/buy2get1",
  },
  title: {
    type: DataTypes.STRING(80),
    allowNull: false,
    comment: "优惠券标题",
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: "generated",
    comment: "generated待领取/claimed已领取/used已核销/expired已失效",
  },
  createdByOpenid: {
    type: DataTypes.STRING(128),
    allowNull: true,
    comment: "生成优惠券的管理员openid",
  },
  claimedByOpenid: {
    type: DataTypes.STRING(128),
    allowNull: true,
    comment: "领取优惠券的用户openid",
  },
  usedByOpenid: {
    type: DataTypes.STRING(128),
    allowNull: true,
    comment: "核销优惠券的用户openid",
  },
  orderNo: {
    type: DataTypes.STRING(64),
    allowNull: true,
    comment: "核销订单编号",
  },
  discountAmount: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: "0",
    comment: "核销抵扣金额（分）",
  },
  claimedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: "领取时间",
  },
  usedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    comment: "核销时间",
  },
  meta: {
    type: DataTypes.JSON,
    defaultValue: {},
    comment: "优惠券规则快照",
  },
});

// 检测样本信息
const Sample = sequelize.define("Sample", {
  openid: {
    type: DataTypes.STRING(128),
    allowNull: true,
    comment: "用户openid",
  },
  title: {
    type: DataTypes.STRING(100),
    defaultValue: "信息登记",
    comment: "检测项目名称",
  },
  type: {
    type: DataTypes.STRING(32),
    defaultValue: "",
    comment: "检测类型 gut/vaginal/inflammation",
  },
  sampleNo: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true,
    comment: "样本编号",
  },
  name: {
    type: DataTypes.STRING(50),
    defaultValue: "",
  },
  age: {
    type: DataTypes.STRING(20),
    defaultValue: "",
  },
  gender: {
    type: DataTypes.STRING(10),
    defaultValue: "",
  },
  phone: {
    type: DataTypes.STRING(20),
    defaultValue: "",
  },
  city: {
    type: DataTypes.STRING(80),
    defaultValue: "",
  },
  height: {
    type: DataTypes.STRING(20),
    defaultValue: "",
  },
  weight: {
    type: DataTypes.STRING(20),
    defaultValue: "",
  },
  antibiotics: {
    type: DataTypes.STRING(10),
    defaultValue: "",
  },
  channel: {
    type: DataTypes.STRING(100),
    defaultValue: "",
  },
  remark: {
    type: DataTypes.STRING(500),
    defaultValue: "",
  },
  extraInfo: {
    type: DataTypes.JSON,
    defaultValue: {},
    comment: "不同检测项目的扩展表单信息",
  },
  status: {
    type: DataTypes.STRING(20),
    defaultValue: "已登记",
    comment: "样本状态",
  },
  source: {
    type: DataTypes.STRING(20),
    defaultValue: "manual",
    comment: "manual/import",
  },
});

// 首页可替换视觉资产：logo、功能 icon 等
const HomeAsset = sequelize.define("HomeAsset", {
  assetKey: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true,
    comment: "资源唯一标识，如 logo/philosophyNatural",
  },
  label: {
    type: DataTypes.STRING(100),
    defaultValue: "",
    comment: "后台展示名称",
  },
  url: {
    type: DataTypes.STRING(1000),
    defaultValue: "",
    comment: "资源文件名/相对路径，后端会拼成 cloud://.../homeAsset/...；也兼容完整 https/cloud:// 地址",
  },
  mimeType: {
    type: DataTypes.STRING(80),
    defaultValue: "",
    comment: "旧字段：数据库图片 MIME 类型，已不推荐使用",
  },
  dataBase64: {
    type: DataTypes.TEXT("long"),
    allowNull: true,
    comment: "旧字段：图片 base64 内容，已不推荐使用",
  },
});

// 首页轮播 Banner：由数据库独立配置
const HomeBanner = sequelize.define("HomeBanner", {
  title: {
    type: DataTypes.STRING(120),
    defaultValue: "",
    comment: "Banner 标题，便于后台识别",
  },
  imageUrl: {
    type: DataTypes.STRING(1000),
    allowNull: false,
    comment: "Banner 图片文件名/相对路径，后端会拼成 cloud://.../homeBanner/...；也兼容完整 https/cloud:// 地址",
  },
  linkType: {
    type: DataTypes.STRING(32),
    defaultValue: "none",
    comment: "跳转类型：none/product/page/url",
  },
  linkValue: {
    type: DataTypes.STRING(500),
    defaultValue: "",
    comment: "跳转目标：spuId、小程序页面路径或外部链接",
  },
  sort: {
    type: DataTypes.INTEGER,
    defaultValue: 0,
    comment: "排序权重，越大越靠前",
  },
  status: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1,
    comment: "状态：1启用 0禁用",
  },
});

const syncModels = [
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
];

async function ensureColumn(tableName, columnName, definition) {
  const queryInterface = sequelize.getQueryInterface();
  const table = await queryInterface.describeTable(tableName);
  if (table[columnName]) return;
  await queryInterface.addColumn(tableName, columnName, definition);
}

async function ensureOnlineSchema() {
  await ensureColumn("Orders", "waybillToken", {
    type: DataTypes.STRING(256),
    allowNull: true,
    comment: "微信物流查询插件 waybill_token",
  });
  await ensureColumn("Orders", "logisticsNo", {
    type: DataTypes.STRING(128),
    allowNull: true,
    comment: "物流运单号",
  });
  await ensureColumn("Orders", "logisticsCompanyCode", {
    type: DataTypes.STRING(64),
    allowNull: true,
    comment: "物流公司编码或运力id",
  });
  await ensureColumn("Orders", "logisticsCompanyName", {
    type: DataTypes.STRING(80),
    allowNull: true,
    comment: "物流公司名称",
  });
  await ensureColumn("Orders", "trajectoryVos", {
    type: DataTypes.JSON,
    defaultValue: [],
    comment: "订单物流轨迹",
  });
  await ensureColumn("Orders", "sampleStatus", {
    type: DataTypes.STRING(32),
    allowNull: true,
    defaultValue: "",
    comment: "检测样本状态 returning/testing/completed",
  });
  await ensureColumn("Orders", "couponNo", {
    type: DataTypes.STRING(64),
    allowNull: true,
    comment: "使用的优惠券编号",
  });
  await ensureColumn("Orders", "couponAmount", {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: "0",
    comment: "优惠券抵扣金额（分）",
  });
  await ensureColumn("Orders", "couponSnapshot", {
    type: DataTypes.JSON,
    defaultValue: null,
    comment: "下单时优惠券快照",
  });
}

// 数据库初始化方法
async function init() {
  for (const model of syncModels) {
    await model.sync(shouldAlterTables ? { alter: true } : {});
  }

  if (!shouldAlterTables) {
    await ensureOnlineSchema();
  }
}

// 导出初始化方法和模型
module.exports = {
  init,
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
};
