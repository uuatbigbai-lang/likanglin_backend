# Environments

I have 2 envs which called 'env-likanglin' and 'env-landianhui'. They're all using Expresss.js framework. Note that they use a same code  repository with different  branches. Below are their configurations:

## env-likanglin

### Public Address: 
https://express-ir28-250440-4-1425492866.sh.run.tcloudbase.com
which will direct to backend index.html.

### how to call it in mini-programe: 
```js
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
```

### Database: MySQL
Account: root
Password: crGRXd2U


### Git branch:
main


----



## env-landianhui

### Public Address: 

https://express-w75d-194260-7-1382535808.sh.run.tcloudbase.com

which will direct to backend index.html.

### how to call it in mini-programe: 
```js
wx.cloud.callContainer({
  "config": {
    "env": "prod-9g6y0u3hbace7b1e"
  },
  "path": "/api/count",
  "header": {
    "X-WX-SERVICE": "express-w75d"
  },
  "method": "POST",
  "data": {
    "action": "inc"
  }
})
```

### Database: MySQL
Account: root
Password: Bai19971202

### Git branch:
landianhui

