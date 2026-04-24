const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const { init: initDB, Counter, Product } = require("./db");

const logger = morgan("tiny");

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(cors());
app.use(logger);

// 首页
app.get("/", async (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// 更新计数
app.post("/api/count", async (req, res) => {
  const { action } = req.body;
  if (action === "inc") {
    await Counter.create();
  } else if (action === "clear") {
    await Counter.destroy({
      truncate: true,
    });
  }
  res.send({
    code: 0,
    data: await Counter.count(),
  });
});

// 获取计数
app.get("/api/count", async (req, res) => {
  const result = await Counter.count();
  res.send({
    code: 0,
    data: result,
  });
});

// 小程序调用，获取微信 Open ID
app.get("/api/wx_openid", async (req, res) => {
  if (req.headers["x-wx-source"]) {
    res.send(req.headers["x-wx-openid"]);
  }
});

// 获取商品列表
app.get("/api/products", async (req, res) => {
  try {
    const products = await Product.findAll({
      where: { status: 1 },
      order: [["sort", "DESC"], ["createdAt", "DESC"]],
    });
    res.send({ code: 0, data: products });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 初始化种子商品数据（仅当表为空时插入）
app.post("/api/products/seed", async (req, res) => {
  try {
    const count = await Product.count();
    if (count > 0) {
      return res.send({ code: 0, message: "商品数据已存在，无需重复初始化", data: { count } });
    }

    const seedData = [
      {
        spuId: "spu_probiotic_01",
        title: "清畅益生菌粉（成人款）",
        brief: "含300亿活性乳酸菌，呵护肠道微生态平衡，每天一袋，轻松享受清爽好肠道。",
        price: 168,
        thumb: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-09a.png",
        badge: "人气爆款",
        sort: 30,
      },
      {
        spuId: "spu_probiotic_02",
        title: "儿童果味益生菌咀嚼片",
        brief: "专为儿童设计，酸甜果味易接受，6种优选菌株协同守护宝宝娇嫩肠胃。",
        price: 128,
        thumb: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-08a.png",
        badge: "妈妈之选",
        sort: 20,
      },
      {
        spuId: "spu_probiotic_03",
        title: "女性私护益生菌胶囊",
        brief: "甄选鼠李糖乳杆菌等专利菌株，由内而外护女性健康，科学守护私密平衡。",
        price: 198,
        thumb: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-10a.png",
        badge: "",
        sort: 10,
      },
    ];

    await Product.bulkCreate(seedData);
    res.send({ code: 0, message: "种子数据初始化成功", data: { count: seedData.length } });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

const port = process.env.PORT || 80;

async function bootstrap() {
  await initDB();
  app.listen(port, () => {
    console.log("启动成功", port);
  });
}

bootstrap();
