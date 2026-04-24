const { Sequelize, DataTypes } = require("sequelize");

// 判断是否为本地开发环境（没有 MYSQL_ADDRESS 时使用 SQLite 内存数据库）
const { MYSQL_USERNAME, MYSQL_PASSWORD, MYSQL_ADDRESS = "" } = process.env;
const isLocal = !MYSQL_ADDRESS;

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
  thumb: {
    type: DataTypes.STRING(500),
    allowNull: true,
    comment: "缩略图URL",
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
  primaryImage: {
    type: DataTypes.STRING(500),
    allowNull: true,
    comment: "商品主图URL",
  },
  images: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: [],
    comment: "商品轮播图列表JSON",
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
  desc: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: [],
    comment: "商品详情图片列表JSON",
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
});

// 数据库初始化方法
async function init() {
  await Counter.sync({ alter: true });
  await Product.sync({ alter: true });
  await Address.sync({ alter: true });
  await CartItem.sync({ alter: true });
  await Order.sync({ alter: true });
}

// 导出初始化方法和模型
module.exports = {
  init,
  Counter,
  Product,
  Address,
  CartItem,
  Order,
};
