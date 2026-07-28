# 多账号网络身份配置清单

本页用于你回到 Windows 电脑后完成最后一公里配置。代码、Manifest 生成和验收流程已经自动化；你不需要手工编写完整 JSON。

## 你需要准备的值

每台电脑只需要确认一次：

1. Chrome 可执行文件路径。常见路径：
   - `C:\Program Files\Google\Chrome\Application\chrome.exe`
   - `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`
2. 独立浏览器资料目录的根路径，例如：
   - `D:\KvBrowserBridge\profiles`
3. Clash 或 Mihomo 为每个账号开放的本地代理入口端口。

每个账号需要填写：

- `identityId`：只用小写英文、数字和短横线，例如 `huice-xhs`；
- `accountLabel`：方便人阅读的账号名称；
- `proxyPort`：该账号独占的 Clash 本地入口端口；
- 可选的国家、时区和语言配置。

不得让两个身份复用同一个 `host:port`。生成器会直接拒绝重复端口。

## 第一步：复制配置模板

复制：

```text
examples/network-identities.setup.example.json
```

保存为你自己的文件，例如：

```text
local/network-identities.setup.json
```

这个本地配置文件不应提交到公开仓库，尤其是在后续加入私人账号标签或内部网络信息时。

## 第二步：填写 Clash 入口

示例：

```json
{
  "identities": [
    {
      "identityId": "account-a-xhs",
      "accountLabel": "小红书账号 A",
      "proxyPort": 17891
    },
    {
      "identityId": "account-b-xhs",
      "accountLabel": "小红书账号 B",
      "proxyPort": 17892
    }
  ]
}
```

这里的 `17891` 和 `17892` 必须是 Clash/Mihomo 中两个不同的本地 inbound。不同端口还不够，最终验收会确认它们实际对应不同公网出口。

## 第三步：生成身份文件

在仓库根目录运行：

```powershell
npm run generate:network-identities -- --config .\local\network-identities.setup.json --output .\local\generated-identities
```

生成器会创建：

- 每个账号独立的身份 Manifest；
- 每个账号独立的 Chrome `userDataDir`；
- `run-acceptance.ps1` 一键验收启动器。

## 第四步：运行最终验收

```powershell
.\local\generated-identities\run-acceptance.ps1
```

脚本会自动执行：

- 构建、测试和类型检查；
- 检查每个代理端口；
- 启动每个独立 Chrome 身份；
- 验证浏览器真实公网出口；
- 检查账号之间是否撞公网 IP；
- 检查 WebRTC、IPv6 和已配置的 DNS 证据；
- 失败时停止相关 Chrome 并冻结身份；
- 输出 `network-isolation-acceptance.json`。

## DNS 探测配置

公网 IP、IPv6 和 WebRTC 已有自动采集逻辑。DNS 路径要做到可信验收，需要一个 HTTPS 服务返回该请求在服务端观察到的 DNS 解析器信息。

如果暂时没有这样的服务：

- 不要填假的地址；
- DNS 项会保持 `unverified`；
- 严格验收不会把它判定为通过。

配置格式：

```json
{
  "dnsProbeUrl": "https://your-dns-probe.example/result",
  "expectedDnsResolvers": ["预期解析器 IP"]
}
```

## 你不需要现在准备的东西

- 不需要把小红书密码交给本项目；
- 不需要把代理用户名或密码写进 Chrome 参数；
- 使用 Clash 本地无认证入口时，不需要认证代理适配器；
- 不需要为了测试批量注册、模拟互动或规避平台规则。

## 真机验收通过标准

只有以下条件同时成立，才把一个身份视为可用：

1. 独立 Chrome Profile；
2. 独立且可达的本地代理入口；
3. 浏览器真实公网出口与自己的基线一致；
4. 不与其他身份共享公网 IP；
5. 当前网络记录属于当前 `runtimeSessionId`；
6. WebRTC 不出现未允许的候选地址；
7. IPv6 符合身份策略；
8. DNS 证据符合预期，或明确标记为尚未完成而不投入正式使用。

这套验收降低账号环境意外串线和共享出口暴露，不承诺平台不会基于其他信号进行关联或风控。
