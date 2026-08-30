  3. 注册 + 安装
  /plugin marketplace add ~/IdeaProjects/teaho-infra/codebuddy-lark-plugin -n local-marketplace
  /plugin install codebuddy-lark-channel@codebuddy-lark-plugin

  注意：marketplace 名取自 marketplace.json 的 name 字段（codebuddy-lark-plugin），
  不是 -n 传入值；插件名是 codebuddy-lark-channel。改动后需提交 git 并 bump 版本
  重新 install，否则缓存目录（plugins/cache/<mp>/<plugin>/<version>）会复用旧内容。
