# vscode-integration

> 我的第一个vscode插件

## 安装环境

```shell
npm install -g yo generator-code
```
1. yo: 是一个通用的项目脚手架工具，核心作用是自动生成项目结构 + 初始代码
2. generator-code: 一个 Yeoman 的 generator（插件）,也就是专门用来生成 VS Code 插件项目 的模板工具

```shell
# 安装打包工具
npm install -g vsce

# 如果用 TypeScript 则需要先编译
npm run compile

# 打包
vsce package

# 安装到 vscode
code --install-extension xxx.vsix

# 发布到 marketplace
vsce login xxx
vsce publish
```
