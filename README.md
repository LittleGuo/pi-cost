# pi-cost

在 [pi](https://pi.dev) 状态栏显示 **DeepSeek 账户余额**和**当前会话花费**（人民币）。

```
余额 ¥32.94 · 本会话 ¥0.0125
```

## 功能

- 余额：用当前供应商解析出的 API key 调 `GET /user/balance`，取 CNY 余额
- 花费：汇总当前分支每条 usage 的费用，按 DeepSeek 峰谷规则折算（谷时 5 折）
- 每次对话结束刷新花费，余额最多每 5 分钟拉一次
- 没配单价时显示 `未配置单价`，不会假装是 0 元

## 安装

```bash
pi install git:github.com/LittleGuo/pi-cost@main
```

装完在会话里 `/reload` 或重启 pi。`pi list` 里能看到 `pi-cost` 即成功。

其它方式：

```bash
# 本地目录（改代码后 /reload 直接生效，不用重装）
pi install /path/to/pi-cost

# 只临时试用一次，不写入配置
pi -e /path/to/pi-cost
```

卸载：`pi remove git:github.com/LittleGuo/pi-cost`

要求：pi 1.6+，供应商为 `deepseek`（`https://api.deepseek.com`），已通过 `DEEPSEEK_API_KEY` 或 `/login deepseek` 配好 key。

## 配置单价

pi 的 `cost` 没有时间维度，只能填**峰时价**。本项目统一按**人民币元 / 百万 token** 填（pi 官方定义是 USD，它自己的 footer 会用 `$` 显示同样的数字）。

`~/.pi/agent/models.json`：

```json
{
  "providers": {
    "deepseek": {
      "baseUrl": "https://api.deepseek.com",
      "api": "openai-completions",
      "apiKey": "$DEEPSEEK_API_KEY",
      "models": [
        {
          "id": "deepseek-flash",
          "cost": { "input": 2, "output": 8, "cacheRead": 0.04, "cacheWrite": 0 }
        }
      ],
      "modelOverrides": {
        "deepseek-v4-pro": { "cost": { "input": 9, "output": 27, "cacheRead": 0.3 } }
      }
    }
  }
}
```

官方峰时价（元/百万 token，2026-11 核对，来源 [DeepSeek 价目页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)）：

| 模型 | 缓存命中 | 缓存未命中 | 输出 |
|---|---|---|---|
| deepseek-flash | 0.04 | 2 | 8 |
| deepseek-v4-pro | 0.30 | 9 | 27 |

谷时价一律是峰时的一半。`cacheWrite` 为 0（DeepSeek 不收缓存写入费）。四项必填，缺字段会导致整个 `models.json` 校验失败。

`modelOverrides` 用来给 catalog 里没被 `models` 覆盖的模型也换成人民币价，否则这些模型仍按 USD 计价，插件会把美元数字当人民币显示。

## 峰谷规则

峰时：北京时间周一至周五 09:00–12:00、14:00–18:00，不含中国法定节假日。其余时间（夜间、午休、周末、节假日）都是谷时。

- 每条 usage 按自己的时间戳判断，不依赖运行时刻
- 内置 2026、2027 年法定节假日（来源 [holiday-cn](https://github.com/NateScarlet/holiday-cn)，原始出处国务院办公厅通知）
- 调休补班的周末算谷时（官方口径是"周一至周五"）
- 跨年后需补充新一年的日期，或用环境变量追加

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_CN_HOLIDAYS` | 空 | 逗号分隔的 `YYYY-MM-DD`，追加到内置节假日表 |

## 已知限制

- pi 把 `cost` 当 USD，自带 footer 和 `/session` 会用 `$` 显示人民币数值；本插件固定显示 `¥`
- 只有 `models.json` 里按人民币配了价的模型才准确
- 非 deepseek 供应商只显示会话花费，不显示余额、不做峰谷修正
- 花费是本地估算，和 DeepSeek 账单可能有极小差异（并发调用、跨峰谷边界的请求）

## 文件

```
index.ts      插件本体（单文件，无依赖）
package.json  pi 包清单
```

## License

MIT
