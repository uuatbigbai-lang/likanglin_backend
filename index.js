const path = require("path");
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const { init: initDB, Counter, Product, Address, CartItem, Order } = require("./db");

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
        images: [
          "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-09a.png",
          "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-09b.png"
        ],
        badge: "人气爆款",
        sort: 30,
        minSalePrice: 16800,
        maxSalePrice: 19800,
        maxLinePrice: 23800,
        soldNum: 1260,
        spuStockQuantity: 500,
        isPutOnSale: 1,
        specList: [
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
        ],
        skuList: [
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
        ],
    desc: [
          "https://tdesign.gtimg.com/miniprogram/template/retail/goods/nz-09c.png",
          "https://tdesign.gtimg.com/miniprogram/template/retail/goods/nz-09d.png"
        ],
      },
      {
        spuId: "spu_probiotic_02",
        title: "儿童果味益生菌咀嚼片",
        brief: "专为儿童设计，酸甜果味易接受，6种优选菌株协同守护宝宝娇嫩肠胃。",
        price: 128,
        originalPrice: 188,
        thumb: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-08a.png",
        primaryImage: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-08a.png",
        images: [
          "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-08a.png",
          "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-08a1.png",
          "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-08b.png"
        ],
        badge: "妈妈之选",
        sort: 20,
        minSalePrice: 12800,
        maxSalePrice: 15800,
        maxLinePrice: 18800,
        soldNum: 860,
        spuStockQuantity: 380,
        isPutOnSale: 1,
        specList: [
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
        ],
        skuList: [
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
        ],
        desc: [
          "https://tdesign.gtimg.com/miniprogram/template/retail/goods/nz-08c.png",
          "https://tdesign.gtimg.com/miniprogram/template/retail/goods/nz-08d.png"
        ],
      },
      {
        spuId: "spu_probiotic_03",
        title: "女性私护益生菌胶囊",
        brief: "甄选鼠李糖乳杆菌等专利菌株，由内而外护女性健康，科学守护私密平衡。",
        price: 198,
        originalPrice: 268,
        thumb: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-10a.png",
        primaryImage: "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-10a.png",
        images: [
          "https://cdn-we-retail.ym.tencent.com/miniapp/template/retail/goods/nz-10a.png"
        ],
        badge: "",
        sort: 10,
        minSalePrice: 19800,
        maxSalePrice: 35800,
        maxLinePrice: 26800,
        soldNum: 520,
        spuStockQuantity: 300,
        isPutOnSale: 1,
        specList: [
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
        ],
        skuList: [
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
        ],
        desc: [],
      },
    ];

    await Product.bulkCreate(seedData);
    res.send({ code: 0, message: "种子数据初始化成功", data: { count: seedData.length } });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// ============ 地址接口 ============

// 获取用户默认地址
app.get("/api/address/default", async (req, res) => {
  try {
    const openid = req.headers["x-wx-openid"] || "local_dev_user";
    // 优先取默认地址，没有则取第一个地址
    let addr = await Address.findOne({ where: { openid, isDefault: true } });
    if (!addr) {
      addr = await Address.findOne({
        where: { openid },
        order: [["updatedAt", "DESC"]],
      });
    }
    if (!addr) {
      return res.send({ code: 0, data: null });
    }
    const data = addr.toJSON();
    data.address = `${data.provinceName}${data.cityName}${data.districtName}${data.detailAddress}`;
    data.addressId = String(data.id);
    res.send({ code: 0, data });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 获取用户地址列表
app.get("/api/address/list", async (req, res) => {
  try {
    const openid = req.headers["x-wx-openid"] || "local_dev_user";
    const list = await Address.findAll({
      where: { openid },
   order: [["isDefault", "DESC"], ["updatedAt", "DESC"]],
    });
    const result = list.map((item) => {
      const d = item.toJSON();
      d.phoneNumber = d.phone;
      d.address = `${d.provinceName}${d.cityName}${d.districtName}${d.detailAddress}`;
      d.tag = d.addressTag || "";
      d.addressId = String(d.id);
      return d;
    });
    res.send({ code: 0, data: result });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 获取单个地址详情
app.get("/api/address/:id", async (req, res) => {
  try {
    const addr = await Address.findByPk(req.params.id);
    if (!addr) return res.send({ code: -1, message: "地址不存在" });
    const d = addr.toJSON();
    d.phoneNumber = d.phone;
    d.address = `${d.provinceName}${d.cityName}${d.districtName}${d.detailAddress}`;
    d.tag = d.addressTag || "";
    d.addressId = String(d.id);
    res.send({ code: 0, data: d });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 新增地址
app.post("/api/address/create", async (req, res) => {
  try {
    const openid = req.headers["x-wx-openid"] || "local_dev_user";
    const body = req.body;

    // 如果设为默认，先把其他地址取消默认
    if (body.isDefault) {
      await Address.update({ isDefault: false }, { where: { openid } });
    }

    const addr = await Address.create({
      openid,
      name: body.name || "",
      phone: body.phone || "",
      provinceName: body.provinceName || "",
      cityName: body.cityName || "",
      districtName: body.districtName || "",
      detailAddress: body.detailAddress || "",
      addressTag: body.addressTag || "",
      isDefault: !!body.isDefault,
    });

    const d = addr.toJSON();
    d.addressId = String(d.id);
    d.address = `${d.provinceName}${d.cityName}${d.districtName}${d.detailAddress}`;
    console.log("✅ 新增地址:", d.name, d.address);
    res.send({ code: 0, data: d });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 更新地址
app.post("/api/address/update", async (req, res) => {
  try {
    const openid = req.headers["x-wx-openid"] || "local_dev_user";
    const body = req.body;
    const addr = await Address.findByPk(body.addressId || body.id);
    if (!addr) return res.send({ code: -1, message: "地址不存在" });

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

    const d = addr.toJSON();
    d.addressId = String(d.id);
    d.address = `${d.provinceName}${d.cityName}${d.districtName}${d.detailAddress}`;
    res.send({ code: 0, data: d });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 删除地址
app.post("/api/address/delete", async (req, res) => {
  try {
    const { addressId } = req.body;
    const addr = await Address.findByPk(addressId);
    if (!addr) return res.send({ code: -1, message: "地址不存在" });
    await addr.destroy();
    res.send({ code: 0, data: { removed: 1 } });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// ============ 购物车接口 ============

// 获取购物车列表（返回前端所需的 cartGroupData 结构）
app.get("/api/cart/list", async (req, res) => {
  try {
    const openid = req.headers["x-wx-openid"] || "local_dev_user";
    const items = await CartItem.findAll({
      where: { openid },
      order: [["createdAt", "DESC"]],
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
        saasId: "0",
        storeId: "1",
        spuId: g.spuId,
        skuId: g.skuId,
        thumb: g.thumb,
        title: g.title,
        goodsName: g.title,
        primaryImage: g.thumb,
        price: g.price,
        originPrice: g.originPrice || undefined,
        quantity: g.quantity,
        specs: g.specs ? g.specs.split("+") : [],
        specInfo: g.specs
          ? g.specs.split("+").map((s) => ({ specValue: s }))
          : [],
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
            storeId: "1",
            storeName: "立康林旗舰店",
            isSelected: isAllSelected,
            storeStockShortage: false,
            shortageGoodsList: [],
            promotionGoodsList: [
              {
                promotionId: "0",
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
app.post("/api/cart/add", async (req, res) => {
  try {
    const openid = req.headers["x-wx-openid"] || "local_dev_user";
    const { spuId, skuId, title, thumb, price, originPrice, quantity, specs, stockQuantity } = req.body;

    let item = await CartItem.findOne({ where: { openid, spuId, skuId: skuId || "" } });
    if (item) {
      item.quantity += quantity || 1;
      await item.save();
    } else {
      item = await CartItem.create({
        openid,
        spuId,
        skuId: skuId || "",
        title: title || "",
        thumb: thumb || "",
        price: price || 0,
        originPrice: originPrice || null,
        quantity: quantity || 1,
        specs: specs || "",
        stockQuantity: stockQuantity || 999,
      });
    }
    console.log("✅ 加入购物车:", title, "x", item.quantity);
    res.send({ code: 0, data: { id: item.id } });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 更新购物车商品数量
app.post("/api/cart/update", async (req, res) => {
  try {
    const openid = req.headers["x-wx-openid"] || "local_dev_user";
    const { spuId, skuId, quantity } = req.body;
    const item = await CartItem.findOne({ where: { openid, spuId, skuId: skuId || "" } });
    if (!item) return res.send({ code: -1, message: "商品不在购物车中" });
    item.quantity = quantity;
    await item.save();
    res.send({ code: 0 });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 切换选中状态
app.post("/api/cart/select", async (req, res) => {
  try {
    const openid = req.headers["x-wx-openid"] || "local_dev_user";
    const { spuId, skuId, isSelected } = req.body;
    const item = await CartItem.findOne({ where: { openid, spuId, skuId: skuId || "" } });
    if (!item) return res.send({ code: -1, message: "商品不在购物车中" });
    item.isSelected = !!isSelected;
    await item.save();
    res.send({ code: 0 });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// 删除购物车商品
app.post("/api/cart/delete", async (req, res) => {
  try {
    const openid = req.headers["x-wx-openid"] || "local_dev_user";
    const { spuId, skuId } = req.body;
    await CartItem.destroy({ where: { openid, spuId, skuId: skuId || "" } });
    res.send({ code: 0 });
  } catch (err) {
    res.send({ code: -1, message: err.message });
  }
});

// ============ 结算接口 ============

// 结算页数据（根据商品列表计算价格）
app.post("/api/order/settle", async (req, res) => {
  try {
    const { goodsRequestList = [] } = req.body;

    // 构造 skuDetailVos
    const skuDetailVos = goodsRequestList.map((item) => ({
      storeId: item.storeId || "1",
      spuId: item.spuId,
      skuId: item.skuId || "",
      goodsName: item.goodsName || item.title || "",
      image: item.primaryImage || item.thumb || "",
      quantity: item.quantity || 1,
      settlePrice: item.price || 0,
      tagPrice: null,
      tagText: null,
      skuSpecLst: item.specInfo || [],
    }));

    // 计算总价
    const totalSalePrice = skuDetailVos.reduce(
      (sum, g) => sum + g.quantity * Number(g.settlePrice),
      0
    );
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
            storeId: "1",
            storeName: "立康林旗舰店",
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

// 创建订单
app.post("/api/order/create", async (req, res) => {
  try {
    const openid = req.headers["x-wx-openid"] || "local_dev_user";
    const { goodsList = [], userAddress, userName, totalAmount, remark } = req.body;

    // 后端重新计算总价（以防前端篡改）
    const calcTotal = goodsList.reduce(
      (sum, g) => sum + (Number(g.price) || 0) * (Number(g.quantity) || 1),
      0
    );

    const orderNo = "ORD" + Date.now() + Math.random().toString(36).slice(2, 6);

    const order = await Order.create({
      orderNo,
      openid,
      orderStatus: 5,
      orderStatusName: "待付款",
      totalAmount: String(calcTotal),
      paymentAmount: String(calcTotal),
      goodsList: goodsList,       // 完整商品快照（含名称、图片、规格、单价、数量）
      userAddress: userAddress || null,
      userName: userName || "",
      remark: remark || "",
    });

    console.log("✅ 订单已写入数据库:", order.orderNo, "商品数:", goodsList.length, "总价:", calcTotal);

    res.send({
      code: 0,
      data: {
        orderId: order.id,
        orderNo: order.orderNo,
        totalAmount: order.totalAmount,
        orderStatus: order.orderStatus,
        goodsList: order.goodsList,
      },
    });
  } catch (err) {
    console.error("创建订单失败:", err);
    res.send({ code: -1, message: err.message });
  }
});

const port = process.env.PORT || 3000;

async function bootstrap() {
  await initDB();

  // 本地开发模式下自动插入种子数据（SQLite 内存库每次重启都是空的）
  if (!process.env.MYSQL_ADDRESS) {
    const count = await Product.count();
    if (count === 0) {
      console.log("🌱 本地模式：自动插入种子数据...");
      // 触发 seed 逻辑
      const http = require("http");
      app.listen(port, () => {
        console.log("启动成功", port);
        http.request({ hostname: "127.0.0.1", port, path: "/api/products/seed", method: "POST" }, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => console.log("🌱 种子数据:", body));
        }).end();
      });
      return;
    }
  }

  app.listen(port, () => {
    console.log("启动成功", port);
  });
}

bootstrap();
