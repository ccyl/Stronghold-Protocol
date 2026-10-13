#!/usr/bin/env bash
# build-shell.sh —— 用 Windows 自带的 C# 编译器编译「薄壳版」启动器（不需要装 .NET SDK / Visual Studio）
#
#   bash build-shell.sh
#
# 依赖（都在本目录，来自 NuGet 包 Microsoft.Web.WebView2 1.0.4258.31 的 lib/net462 + runtimes/win-x64/native）：
#   Microsoft.Web.WebView2.Core.dll
#   Microsoft.Web.WebView2.WinForms.dll
#   WebView2Loader.dll
set -e
cd "$(dirname "$0")"

CSC="C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe"   # .NET Framework 4.8 自带（C# 5）
[ -f "$CSC" ] || CSC="C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe"
[ -f "$CSC" ] || { echo "找不到 csc.exe（.NET Framework 4.x 自带）" >&2; exit 1; }

"$CSC" /nologo /target:winexe /platform:x64 /codepage:65001 /optimize+ \
  /out:StrongholdShell.exe /win32icon:icon.ico \
  /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll \
  /r:Microsoft.Web.WebView2.Core.dll /r:Microsoft.Web.WebView2.WinForms.dll \
  Shell.cs

echo "built: $(pwd)/StrongholdShell.exe"
