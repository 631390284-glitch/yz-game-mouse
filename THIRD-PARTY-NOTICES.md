# 第三方组件声明（Third-Party Notices）

本仓库包含并依赖以下第三方组件，全部按其原始许可证随附分发。

## 1. Tracky Mouse（原项目，本补丁的修改对象）

- 作者：Isaiah Odhner — https://github.com/1j01/tracky-mouse
- 许可证：MIT License（见根目录 LICENSE.txt）
- `patch/resources/app/` 下与官方 3.1.0 不一致的文件均为修改版本；完整差异见 `changes.diff`。

## 2. sherpa-onnx 与中文关键词spotting模型

- 项目：https://github.com/k2-fsa/sherpa-onnx
- 许可证：Apache License 2.0
- 随附文件：`patch/resources/app/node_modules/sherpa-onnx/`（WASM 运行时）、
  `patch/resources/app/node_modules/tracky-mouse/vendor/kws/`（zipformer int8 关键词模型 encoder/decoder/joiner 与 tokens.txt）
- 模型来源：k2-fsa / sherpa-onnx 发布的中文（WenetSpeech）关键词模型，Apache-2.0。

## 3. ViGEmClient

- 项目：https://github.com/nefarius/ViGEm
- 许可证：见 `patch/resources/bin/licenses/ViGEmClient-LICENSE.txt`
- 随附文件：`patch/resources/bin/ViGEmClient.dll`

> 注：ViGEmClient.dll 为可选组件（3D 游戏手柄映射功能使用），系统还需另行安装
> ViGEmBus 驱动（https://github.com/nefarius/ViGEmBus/releases）。
