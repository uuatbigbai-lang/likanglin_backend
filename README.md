# wxcloudrun-express

[![GitHub license](https://img.shields.io/github/license/WeixinCloud/wxcloudrun-express)](https://github.com/WeixinCloud/wxcloudrun-express)
![GitHub package.json dependency version (prod)](https://img.shields.io/github/package-json/dependency-version/WeixinCloud/wxcloudrun-express/express)
![GitHub package.json dependency version (prod)](https://img.shields.io/github/package-json/dependency-version/WeixinCloud/wxcloudrun-express/sequelize)

微信云托管 Node.js Express 框架模版，实现简单的计数器读写接口，使用云托管 MySQL 读写、记录计数值。

![](https://qcloudimg.tencent-cloud.cn/raw/be22992d297d1b9a1a5365e606276781.png)

## 快速开始

前往 [微信云托管快速开始页面](https://cloud.weixin.qq.com/cloudrun/onekey)，选择相应语言的模板，根据引导完成部署。

## 本地调试
下载代码在本地调试，请参考[微信云托管本地调试指南](https://developers.weixin.qq.com/miniprogram/dev/wxcloudrun/src/guide/debug/)

## 实时开发
代码变动时，不需要重新构建和启动容器，即可查看变动后的效果。请参考[微信云托管实时开发指南](https://developers.weixin.qq.com/miniprogram/dev/wxcloudrun/src/guide/debug/dev.html)

## Dockerfile最佳实践
请参考[如何提高项目构建效率](https://developers.weixin.qq.com/miniprogram/dev/wxcloudrun/src/scene/build/speed.html)

## 项目结构说明

```
.
├── Dockerfile
├── README.md
├── container.config.json
├── db.js
├── index.js
├── index.html
├── package.json
```

- `index.js`：项目入口，实现主要的读写 API
- `db.js`：数据库相关实现，使用 `sequelize` 作为 ORM
- `index.html`：首页代码
- `package.json`：Node.js 项目定义文件
- `container.config.json`：模板部署「服务设置」初始化配置（二开请忽略）
- `Dockerfile`：容器配置文件

## 服务 API 文档

### `GET /api/count`

获取当前计数

#### 请求参数

无

#### 响应结果

- `code`：错误码
- `data`：当前计数值

##### 响应结果示例

```json
{
  "code": 0,
  "data": 42
}
```

#### 调用示例

```
curl https://<云托管服务域名>/api/count
```

### `POST /api/count`

更新计数，自增或者清零

#### 请求参数

- `action`：`string` 类型，枚举值
  - 等于 `"inc"` 时，表示计数加一
  - 等于 `"clear"` 时，表示计数重置（清零）

##### 请求参数示例

```
{
  "action": "inc"
}
```

#### 响应结果

- `code`：错误码
- `data`：当前计数值

##### 响应结果示例

```json
{
  "code": 0,
  "data": 42
}
```

#### 调用示例

```
curl -X POST -H 'content-type: application/json' -d '{"action": "inc"}' https://<云托管服务域名>/api/count
```

## 使用注意
如果不是通过微信云托管控制台部署模板代码，而是自行复制/下载模板代码后，手动新建一个服务并部署，需要在「服务设置」中补全以下环境变量，才可正常使用，否则会引发无法连接数据库，进而导致部署失败。
- MYSQL_ADDRESS
- MYSQL_PASSWORD
- MYSQL_USERNAME
以上三个变量的值请按实际情况填写。如果使用云托管内MySQL，可以在控制台MySQL页面获取相关信息。

## 微信支付配置

订单接口已支持小程序 JSAPI 微信支付。部署到微信云托管后，在服务环境变量中补全：

- `WECHAT_APP_ID`：小程序 AppID
- `WECHAT_APP_SECRET`：小程序 AppSecret，本地 `wx.request` 调试时用于 `code2session` 换取 openid；云托管正式调用会优先使用 `x-wx-openid`
- `WECHAT_PAY_MCH_ID`：微信支付商户号
- `WECHAT_PAY_SERIAL_NO`：商户 API 证书序列号
- `WECHAT_PAY_PRIVATE_KEY_PATH`：商户 API 私钥 `.pem` 文件路径。相对路径会以 `backend` 目录为基准解析，例如 `certs/apiclient_key.pem`
- `WECHAT_PAY_PRIVATE_KEY`：可选兜底。直接配置商户 API 私钥内容，支持正常 PEM、`\n` 转义 PEM、没有换行的单行 PEM，或 base64 编码后的 PEM
- `WECHAT_PAY_API_V3_KEY`：APIv3 密钥，用于解密支付通知
- `WECHAT_PAY_NOTIFY_URL`：支付通知公网地址，例如 `https://<云托管域名>/api/pay/wechat/notify`
- `WECHAT_PAY_MOCK`：可选。默认为模拟成功；设置为 `false` 后，支付参数缺失会直接报错
- `WECHAT_PAY_LOCAL_TEST_AMOUNT_FEN`：可选。本地开发默认支付金额为 `1` 分，即 0.01 元；需要调整时可改这个值
- `WECHAT_PAY_AMOUNT_MODE`：可选。支付金额模式，`full`/`real` 表示按订单全额支付，`test`/`mock` 表示按测试金额支付。未配置时保持默认：本地 0.01，云托管按订单全额
- `WECHAT_PAY_USE_REAL_AMOUNT`：可选。布尔开关，未配置 `WECHAT_PAY_AMOUNT_MODE` 时生效；`true` 表示全额，`false` 表示测试金额

小程序端在结算页提交订单后，如果后端返回 `payInfo` 会调用 `wx.requestPayment`；未配置微信支付参数时仍保持本地开发的模拟支付成功跳转。本地没有 `MYSQL_ADDRESS` 时，后端向微信支付创建预支付单的金额固定为 0.01 元，订单原始总价仍按商品价格记录。

本地调试可以在 `backend/.env` 中配置支付参数，例如：

```env
WECHAT_PAY_PRIVATE_KEY_PATH=certs/apiclient_key.pem
```


## License

[MIT](./LICENSE)
