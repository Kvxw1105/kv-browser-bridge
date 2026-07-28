# 多账号网络隔离：用户准备清单

你不需要手写 JSON，也不需要现在就登录小红书。代码、构建和离线检查可以先完成；只有真实网络出口与 Chrome 安装验证必须在目标 Windows 电脑上执行。

## 回到电脑后必须确认的 5 项

每个账号只需要准备：

1. 一个稳定的账号标识，例如 `huice-xhs`；
2. 一个独立的 Clash/Mihomo 本地入口端口，例如 `127.0.0.1:17801`；
3. 该入口对应的固定出口国家或地区、时区和语言；
4. Chrome 可执行文件路径；
5. 一个独立的 Chrome 用户数据目录。生成器会自动创建建议路径，不需要手工建目录。

两个账号不得复用同一个本地入口端口、Chrome 用户数据目录或实际公网出口。

## 可以稍后补充的配置

严格 DNS 验收需要：

- 一个返回 DNS 解析器地址的 HTTPS 探测接口；
- 每条 Clash 路由预期出现的 DNS 解析器 IP。

没有这两项时，系统会把 DNS 标记为 `unverified`，不会伪装成已通过。你可以先完成公网出口、WebRTC 和 IPv6 验收，再补 DNS 服务。

## 第一步：生成账号配置

在仓库根目录运行：

```powershell
.\scripts\new-identity-manifest.ps1 `
  -IdentityId 'huice-xhs' `
  -AccountLabel '灰策狼小红书' `
  -ProxyPort 17801 `
  -CountryCode 'CN' `
  -Locale 'zh-CN' `
  -Timezone 'Asia/Shanghai'
```

第二个账号换一个 `IdentityId` 和端口：

```powershell
.\scripts\new-identity-manifest.ps1 `
  -IdentityId 'xuanqi-xhs' `
  -AccountLabel '玄启小红书' `
  -ProxyPort 17802 `
  -CountryCode 'CN' `
  -Locale 'zh-CN' `
  -Timezone 'Asia/Shanghai'
```

生成器默认：

- 不覆盖已有 Manifest；
- 不在配置中写入代理密码；
- WebRTC 使用代理约束；
- 禁用 IPv6，并要求真实验证；
- 使用独立 Chrome Profile；
- 禁止同一身份并发启动。

## 第二步：离线预检

这一步不会登录账号，也不会启动身份 Chrome：

```powershell
.\scripts\prepare-network-isolation.ps1 `
  -Manifest .\identities\huice-xhs.json, .\identities\xuanqi-xhs.json
```

它会检查：

- Manifest 格式；
- Chrome 路径；
- 身份 ID 冲突；
- Profile 路径冲突；
- Clash 本地端口冲突；
- DNS 探测配置缺失；
- 地区、时区和语言是否自洽。

## 第三步：真实验收

确认 Clash 的两个入口已启动，并分别绑定不同稳定出口后运行：

```powershell
.\scripts\accept-network-isolation.ps1 `
  -Manifest .\identities\huice-xhs.json, .\identities\xuanqi-xhs.json `
  -StopAfter
```

脚本会自动完成：

- 构建和测试；
- 代理入口连通性；
- 身份 Chrome 启动；
- 浏览器内部公网 IP 探测；
- 多账号公网 IP 去重；
- WebRTC 候选检查；
- IPv6 检查；
- 已配置时的 DNS 检查；
- 失败后停止 Chrome 并冻结不安全身份；
- 输出 `network-isolation-acceptance.json`。

## 你不需要做的事情

- 不要手动复制 Chrome Profile；
- 不要把代理用户名或密码写进 Chrome 参数；
- 不要为了通过检查而关闭 fail-closed；
- 不要把两个本地端口接到同一个实际公网出口；
- 不要在验收前同时登录多个真实账号；
- 不要把该系统理解为规避平台规则或保证账号不会被关联。

## 真机测试开始前的安全顺序

1. 先用空白 Profile 验收网络；
2. 确认两个出口公网 IP 不同；
3. 确认 WebRTC、IPv6 和 DNS 报告符合策略；
4. 故意制造一次撞 IP，确认两个身份都被冻结；
5. 重置测试环境；
6. 再分别登录真实账号；
7. 先进行普通浏览和正常发布流程，不做批量或模拟互动行为。

最后一公里必须由目标电脑完成，是因为公网出口、Clash 路由、Chrome 扩展安装和真实账号会话都只存在于那台机器上。其余配置、检查、报告和失败保护均已自动化。
