部署成功
Express.js 框架部署成功，你可以进行以下操作：

公网域名访问

访问域名
域名地址

https://express-ir28-250440-4-1425492866.sh.run.tcloudbase.com
小程序/公众号中调用

复制代码片段
wx.cloud.callContainer({
  "config": {
    "env": "prod-d4gu9yrbb28b39fbf"
  },
  "path": "/api/count",
  "header": {
    "X-WX-SERVICE": "express-ir28"
  },
  "method": "POST",
  "data": {
    "action": "inc"
  }
})
模板源代码

可将模板代码复制到自己的在线仓库中，在模板代码的基础上进行自定义开发。

基于模板开发
代码源

github

仓库地址

WeixinCloud/wxcloudrun-express
数据库

数据库账密会以服务通知的形式推送到个人微信中，请注意查收。

数据库管理
账号

root

密码

crGRXd2U

