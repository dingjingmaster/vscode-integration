#!/bin/bash

rm -f *.vsix

npm run compile

vsce package

code --install-extension vscode-integration-*.vsix
