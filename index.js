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
      attributes: ["id", "spuId", "title", "brief", "price", "thumb", "badge", "sort"],
    });
    res.send({ code: 0, data: products });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 获取商品详情
app.get("/api/products/:spuId", async (req, res) => {
  try {
    const product = await Product.findOne({
      where: { spuId: req.params.spuId, status: 1 },
    });
    if (!product) {
      return res.send({ code: -1, message: "商品不存在" });
    }
    res.send({ code: 0, data: product });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 初始化种子商品数据（强制重置）
app.post("/api/products/seed", async (req, res) => {
  try {
    // 清空旧数据并重新插入
    await Product.destroy({ truncate: true });

    const seedData = [
      {
        spuId: "spu_probiotic_01",
        title: "清畅益生菌粉（成人款）",
        brief: "含300亿活性乳酸菌，呵护肠道微生态平衡，每天一袋，轻松享受清爽好肠道。",
        price: 168,
        originalPrice: 238,
        thumb: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-09a.png",
        primaryImage: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-09a.png",
        images: JSON.stringify([
          "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-09a.png",
          "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-09b.png"
        ]),
        badge: "人气爆款",
        sort: 30,
        minSalePrice: 16800,
        maxSalePrice: 19800,
        maxLinePrice: 23800,
        soldNum: 1260,
        spuStockQuantity: 500,
        isPutOnSale: 1,
        specList: JSON.stringify([
          {
            specId: "spec_01_flavor",
            title: "口味",
            specValueList: [
              { specValueId: "sv_01_original", specValue: "原味", image: "" },
              { specValueId: "sv_01_berry", specValue: "混合莓果味", image: "" }
            ]
          },
          {
            specId: "spec_01_count",
            title: "规格",
            specValueList: [
              { specValueId: "sv_01_30", specValue: "30袋/盒", image: "" },
              { specValueId: "sv_01_60", specValue: "60袋/盒（家庭装）", image: "" }
            ]
          }
        ]),
        skuList: JSON.stringify([
          {
            skuId: "sku_01_01",
            skuImage: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-09a.png",
            specInfo: [
              { specId: "spec_01_flavor", specValueId: "sv_01_original" },
              { specId: "spec_01_count", specValueId: "sv_01_30" }
            ],
            priceInfo: [
              { priceType: 1, price: "16800" },
              { priceType: 2, price: "23800" }
            ],
            stockInfo: { stockQuantity: 150, safeStockQuantity: 0, soldQuantity: 0 }
          },
          {
            skuId: "sku_01_02",
            skuImage: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-09a.png",
            specInfo: [
              { specId: "spec_01_flavor", specValueId: "sv_01_original" },
              { specId: "spec_01_count", specValueId: "sv_01_60" }
            ],
            priceInfo: [
              { priceType: 1, price: "19800" },
              { priceType: 2, price: "23800" }
            ],
            stockInfo: { stockQuantity: 120, safeStockQuantity: 0, soldQuantity: 0 }
          },
          {
            skuId: "sku_01_03",
            skuImage: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-09b.png",
            specInfo: [
              { specId: "spec_01_flavor", specValueId: "sv_01_berry" },
              { specId: "spec_01_count", specValueId: "sv_01_30" }
            ],
            priceInfo: [
              { priceType: 1, price: "17800" },
              { priceType: 2, price: "23800" }
            ],
            stockInfo: { stockQuantity: 130, safeStockQuantity: 0, soldQuantity: 0 }
          },
          {
            skuId: "sku_01_04",
            skuImage: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-09b.png",
            specInfo: [
              { specId: "spec_01_flavor", specValueId: "sv_01_berry" },
              { specId: "spec_01_count", specValueId: "sv_01_60" }
            ],
            priceInfo: [
              { priceType: 1, price: "19800" },
              { priceType: 2, price: "23800" }
            ],
            stockInfo: { stockQuantity: 100, safeStockQuantity: 0, soldQuantity: 0 }
          }
        ]),
        desc: JSON.stringify([
          "https://tdesign.gtimg.com/miniprogram/template/retail/goods/nz-09c.png",
          "https://tdesign.gtimg.com/miniprogram/template/retail/goods/nz-09d.png"
        ]),
      },
      {
        spuId: "spu_probiotic_02",
        title: "儿童果味益生菌咀嚼片",
        brief: "专为儿童设计，酸甜果味易接受，6种优选菌株协同守护宝宝娇嫩肠胃。",
        price: 128,
        originalPrice: 188,
        thumb: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-08a.png",
        primaryImage: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-08a.png",
        images: JSON.stringify([
          "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-08a.png",
          "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-08a1.png",
          "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-08b.png"
        ]),
        badge: "妈妈之选",
        sort: 20,
        minSalePrice: 12800,
        maxSalePrice: 15800,
        maxLinePrice: 18800,
        soldNum: 860,
        spuStockQuantity: 380,
        isPutOnSale: 1,
        specList: JSON.stringify([
          {
            specId: "spec_02_flavor",
            title: "口味",
            specValueList: [
              { specValueId: "sv_02_strawberry", specValue: "草莓味", image: "" },
              { specValueId: "sv_02_orange", specValue: "香橙味", image: "" }
            ]
          },
          {
            specId: "spec_02_count",
            title: "规格",
            specValueList: [
              { specValueId: "sv_02_60", specValue: "60片/瓶", image: "" },
              { specValueId: "sv_02_120", specValue: "120片/瓶（实惠装）", image: "" }
            ]
          }
        ]),
        skuList: JSON.stringify([
          {
            skuId: "sku_02_01",
            skuImage: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-08a.png",
            specInfo: [
              { specId: "spec_02_flavor", specValueId: "sv_02_strawberry" },
              { specId: "spec_02_count", specValueId: "sv_02_60" }
            ],
            priceInfo: [
              { priceType: 1, price: "12800" },
              { priceType: 2, price: "18800" }
            ],
            stockInfo: { stockQuantity: 100, safeStockQuantity: 0, soldQuantity: 0 }
          },
          {
            skuId: "sku_02_02",
            skuImage: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-08a.png",
            specInfo: [
              { specId: "spec_02_flavor", specValueId: "sv_02_strawberry" },
              { specId: "spec_02_count", specValueId: "sv_02_120" }
            ],
            priceInfo: [
              { priceType: 1, price: "15800" },
              { priceType: 2, price: "18800" }
            ],
            stockInfo: { stockQuantity: 90, safeStockQuantity: 0, soldQuantity: 0 }
          },
          {
            skuId: "sku_02_03",
            skuImage: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-08b.png",
            specInfo: [
              { specId: "spec_02_flavor", specValueId: "sv_02_orange" },
              { specId: "spec_02_count", specValueId: "sv_02_60" }
            ],
            priceInfo: [
              { priceType: 1, price: "12800" },
              { priceType: 2, price: "18800" }
            ],
            stockInfo: { stockQuantity: 100, safeStockQuantity: 0, soldQuantity: 0 }
          },
          {
            skuId: "sku_02_04",
            skuImage: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-08b.png",
            specInfo: [
              { specId: "spec_02_flavor", specValueId: "sv_02_orange" },
              { specId: "spec_02_count", specValueId: "sv_02_120" }
            ],
            priceInfo: [
              { priceType: 1, price: "15800" },
              { priceType: 2, price: "18800" }
            ],
            stockInfo: { stockQuantity: 90, safeStockQuantity: 0, soldQuantity: 0 }
          }
        ]),
        desc: JSON.stringify([
          "https://tdesign.gtimg.com/miniprogram/template/retail/goods/nz-08c.png",
          "https://tdesign.gtimg.com/miniprogram/template/retail/goods/nz-08d.png"
        ]),
      },
      {
        spuId: "spu_probiotic_03",
        title: "女性私护益生菌胶囊",
        brief: "甄选鼠李糖乳杆菌等专利菌株，由内而外护女性健康，科学守护私密平衡。",
        price: 198,
        originalPrice: 268,
        thumb: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-10a.png",
        primaryImage: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-10a.png",
        images: JSON.stringify([
          "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-10a.png"
        ]),
        badge: "",
        sort: 10,
        minSalePrice: 19800,
        maxSalePrice: 35800,
        maxLinePrice: 26800,
        soldNum: 520,
        spuStockQuantity: 300,
        isPutOnSale: 1,
        specList: JSON.stringify([
          {
            specId: "spec_03_type",
            title: "类型",
            specValueList: [
              { specValueId: "sv_03_daily", specValue: "日常养护型", image: "" },
              { specValueId: "sv_03_intensive", specValue: "密集修护型", image: "" }
            ]
          },
          {
            specId: "spec_03_cycle",
            title: "周期",
            specValueList: [
              { specValueId: "sv_03_1month", specValue: "1个月装（30粒）", image: "" },
              { specValueId: "sv_03_3month", specValue: "3个月装（90粒）", image: "" }
            ]
          }
        ]),
        skuList: JSON.stringify([
          {
            skuId: "sku_03_01",
            skuImage: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-10a.png",
            specInfo: [
              { specId: "spec_03_type", specValueId: "sv_03_daily" },
              { specId: "spec_03_cycle", specValueId: "sv_03_1month" }
            ],
            priceInfo: [
              { priceType: 1, price: "19800" },
              { priceType: 2, price: "26800" }
            ],
            stockInfo: { stockQuantity: 80, safeStockQuantity: 0, soldQuantity: 0 }
          },
          {
            skuId: "sku_03_02",
            skuImage: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-10a.png",
            specInfo: [
              { specId: "spec_03_type", specValueId: "sv_03_daily" },
              { specId: "spec_03_cycle", specValueId: "sv_03_3month" }
            ],
            priceInfo: [
              { priceType: 1, price: "35800" },
              { priceType: 2, price: "26800" }
            ],
            stockInfo: { stockQuantity: 70, safeStockQuantity: 0, soldQuantity: 0 }
          },
          {
            skuId: "sku_03_03",
            skuImage: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-10a.png",
            specInfo: [
              { specId: "spec_03_type", specValueId: "sv_03_intensive" },
              { specId: "spec_03_cycle", specValueId: "sv_03_1month" }
            ],
            priceInfo: [
              { priceType: 1, price: "22800" },
              { priceType: 2, price: "26800" }
            ],
            stockInfo: { stockQuantity: 80, safeStockQuantity: 0, soldQuantity: 0 }
          },
          {
            skuId: "sku_03_04",
            skuImage: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-10a.png",
            specInfo: [
              { specId: "spec_03_type", specValueId: "sv_03_intensive" },
              { specId: "spec_03_cycle", specValueId: "sv_03_3month" }
            ],
            priceInfo: [
              { priceType: 1, price: "35800" },
              { priceType: 2, price: "26800" }
            ],
            stockInfo: { stockQuantity: 70, safeStockQuantity: 0, soldQuantity: 0 }
          }
        ]),
        desc: JSON.stringify([]),
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
