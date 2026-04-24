const { Sequelize, DataTypes } = require("sequelize");

// 从环境变量中读取数据库配置
const { MYSQL_USERNAME, MYSQL_PASSWORD, MYSQL_ADDRESS = "" } = process.env;

const [host, port] = MYSQL_ADDRESS.split(":");

const sequelize = new Sequelize("nodejs_demo", MYSQL_USERNAME, MYSQL_PASSWORD, {
  host,
  port,
  dialect: "mysql" /* one of 'mysql' | 'mariadb' | 'postgres' | 'mssql' */,
});

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
});

// 数据库初始化方法
async function init() {
  await Counter.sync({ alter: true });
  await Product.sync({ alter: true });
}

// 导出初始化方法和模型
module.exports = {
  init,
  Counter,
  Product,
};
