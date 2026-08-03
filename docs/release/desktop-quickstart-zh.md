# KV Browser Bridge 桌面端快速开始（Windows）

目标：安装扩展 + 原生宿主后，从桌面应用创建并管理互相隔离的浏览器身份。

## 一、前置条件

- Windows 10/11，已安装 Google Chrome（桌面版）。
- Node.js 22 与 npm（仅源码构建路径需要）。

## 二、源码路径安装（开发/自用）

```powershell
git clone https://github.com/Kvxw1105/kv-browser-bridge.git
cd kv-browser-bridge
npm install
npm run build:local-chrome
```

1. 打开 Chrome，进入 `chrome://extensions`，开启"开发者模式"。
2. 点击"加载已解压的扩展程序"，选择 `apps/extension/dist`。
3. 复制显示的扩展 ID。
4. 注册原生宿主：

```powershell
node apps/chrome-bridge/dist/install.js install <扩展ID>
```

5. 启动桌面端：

```powershell
npm run dev:desktop
```

## 三、安装包路径（打包分发）

```powershell
npm run dist:desktop
```

产物：`apps/desktop/release/KV Browser Bridge Setup <version>.exe`。安装后从开始菜单或桌面快捷方式启动。

> 安装包路径仍需先完成原生宿主注册与扩展加载（同第二步），或由后续版本内置一键安装。

## 四、创建第一个身份

1. 桌面应用打开后，进入 Identity Console（身份控制台）。
2. 点击 New Identity，填写：
   - Account label（账号标签）
   - Identity ID（身份标识）
   - Chrome path（Chrome 路径）
   - Profile path（独立 Profile 目录，每个身份必须不同）
   - Proxy protocol / host / port（可选代理）
   - Locale / Timezone（可选）
3. 点击 Create，列表出现该身份。
4. 对身份执行 Start / Refresh / Validate / Stop。
5. 创建第二个身份并重复上述操作：两个身份可同时运行、互不影响。

## 五、验证安装是否正常

```powershell
npm run doctor-local-chrome
```

`doctor` 只读检查：Node 运行时、原生宿主清单/注册表、发现配置与日志目录。

## 六、卸载

```powershell
npm run uninstall-local-chrome
```

只删除 Kv 拥有的原生宿主清单与注册项；非 Kv 工件不会被改动。
