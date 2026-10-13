// Shell.cs —— 卫戍协议：盟约 ·「桌面启动器」（薄壳：.NET Framework + 系统 WebView2 内核）
//
//   设计目标：exe 尽量小、目标机器什么都不用装、游戏本体跟官方便携包共享（更新只替换 app\ 目录）。
//
//   浏览器内核 = 系统自带的 WebView2（Edge 内核，Win11 内置；Win10 一般随 Edge 装好）
//   Node 运行时 = 复用便携包里的 node\node.exe
//
//   两种连接模式：
//     本机模式 —— 找到 app\ + node.exe，起服务端（或复用已在跑的），窗口加载 127.0.0.1:<port>
//     远端模式 —— 只把窗口指向别人的服务器（http://192.168.x.x:3000），本机不起任何服务
//
//   用法：
//     StrongholdShell.exe                       默认：本机模式
//     StrongholdShell.exe --connect 192.168.1.23:3000   直连别人的服务器（本机不起服）
//     StrongholdShell.exe --local               强制本机模式
//     StrongholdShell.exe --port 3010           本机模式起始端口
//     StrongholdShell.exe --game <app目录>       指定游戏本体
//     StrongholdShell.exe --smoke [--smoke-out f --smoke-png f]   自检后退出
//
//   配置文件（都在 exe 同级）：
//     shell.json        { "gameRoot": "D:\\...\\app", "port": 3000, "server": "192.168.1.23:3000" }
//     shell-state.json  { "defaultServer": "http://192.168.1.23:3000/" }   ← 菜单里「记住为默认」写的，优先于游戏目录默认
//
//   编译：见 build-shell.sh（用系统自带的 csc.exe，目标 .NET Framework 4.8）
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace StrongholdShell
{
    internal sealed class Options
    {
        public string GameRoot;
        public int Port = 3000;
        public string Connect;          // 远端服务器地址（本机不起服）
        public bool ForceLocal;
        public bool Smoke;
        public bool RawError;
        public string SmokeOut;
        public string SmokePng;
        public bool CheckUpdate;        // --check-update：只做版本自检，写 JSON 报告后退出
        public bool DoUpdate;           // --update：一键更新后退出
        public bool UpdateNoSetup;      // --update-no-setup：更新完不跑 setup（补素材）
        public string UpdateSource;     // --update-source <http(s)://主机:端口 | 目录>
        public string UpdatePubkey;     // --pubkey <ed25519 公钥.pem>
    }

    internal static class Program
    {
        [STAThread]
        private static void Main(string[] argv)
        {
            Options o = Parse(argv);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new ShellForm(o));
        }

        internal static Options Parse(string[] argv)
        {
            Options o = new Options();
            string envPort = Environment.GetEnvironmentVariable("PORT");
            if (!string.IsNullOrEmpty(envPort)) { int p; if (int.TryParse(envPort, out p)) o.Port = p; }
            for (int i = 0; i < argv.Length; i++)
            {
                string a = argv[i];
                if (a == "--game" && i + 1 < argv.Length) o.GameRoot = argv[++i];
                else if (a.StartsWith("--game=")) o.GameRoot = a.Substring(7);
                else if (a == "--port" && i + 1 < argv.Length) o.Port = int.Parse(argv[++i]);
                else if (a.StartsWith("--port=")) o.Port = int.Parse(a.Substring(7));
                else if (a == "--connect" && i + 1 < argv.Length) o.Connect = argv[++i];
                else if (a.StartsWith("--connect=")) o.Connect = a.Substring(10);
                else if (a.StartsWith("--server=")) o.Connect = a.Substring(9);
                else if (a == "--local") o.ForceLocal = true;
                else if (a == "--raw-error") o.RawError = true;
                else if (a == "--smoke") o.Smoke = true;
                else if (a == "--smoke-out" && i + 1 < argv.Length) o.SmokeOut = argv[++i];
                else if (a == "--smoke-png" && i + 1 < argv.Length) o.SmokePng = argv[++i];
                else if (a == "--check-update") o.CheckUpdate = true;
                else if (a == "--update") o.DoUpdate = true;
                else if (a == "--update-no-setup") o.UpdateNoSetup = true;
                else if (a == "--update-source" && i + 1 < argv.Length) o.UpdateSource = argv[++i];
                else if (a.StartsWith("--update-source=")) o.UpdateSource = a.Substring(16);
                else if (a == "--pubkey" && i + 1 < argv.Length) o.UpdatePubkey = argv[++i];
                else if (a.StartsWith("--pubkey=")) o.UpdatePubkey = a.Substring(9);
            }
            return o;
        }

        internal static bool IsGame(string dir)
        {
            if (string.IsNullOrEmpty(dir)) return false;
            return File.Exists(Path.Combine(dir, Path.Combine("server", "index.js")));
        }

        /// <summary>找游戏本体目录：命令行 &gt; 环境变量 &gt; shell.json &gt; exe 同级/上级的常见布局。</summary>
        internal static string ResolveGameRoot(Options o)
        {
            if (!string.IsNullOrEmpty(o.GameRoot))
                return IsGame(o.GameRoot) ? o.GameRoot : null;
            string env = Environment.GetEnvironmentVariable("SP_GAME_ROOT");
            if (IsGame(env)) return env;

            string exeDir = Path.GetDirectoryName(Application.ExecutablePath);
            string cfg = Path.Combine(exeDir, "shell.json");
            if (File.Exists(cfg))
            {
                string g = JsonStringValue(cfg, "gameRoot");
                if (!string.IsNullOrEmpty(g))
                {
                    if (!Path.IsPathRooted(g)) g = Path.Combine(exeDir, g);
                    if (IsGame(g)) return Path.GetFullPath(g);
                }
            }

            string[] cands = new string[] {
                Path.Combine(exeDir, "app"),                                  // exe 直接放进便携包根目录（推荐）
                Path.Combine(exeDir, "game"),                                 // exe 旁边放一个 game\ 软链/目录
                Path.Combine(exeDir, @"..\Stronghold-Protocol-Windows\app"),  // exe 和便携包并列
                Path.Combine(exeDir, @"..\app"),
            };
            foreach (string c in cands)
            {
                string full = Path.GetFullPath(c);
                if (IsGame(full)) return full;
            }
            return null;
        }

        /// <summary>找 node.exe：便携包的 node\ &gt; gameRoot\node\ &gt; PATH。</summary>
        internal static string ResolveNode(string gameRoot)
        {
            List<string> cands = new List<string>();
            if (!string.IsNullOrEmpty(gameRoot))
            {
                cands.Add(Path.GetFullPath(Path.Combine(gameRoot, @"..\node\node.exe")));
                cands.Add(Path.Combine(gameRoot, @"node\node.exe"));
            }
            cands.Add(Path.GetFullPath(Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), @"node\node.exe")));
            foreach (string c in cands) if (File.Exists(c)) return c;

            string pathVar = Environment.GetEnvironmentVariable("PATH");
            if (!string.IsNullOrEmpty(pathVar))
            {
                foreach (string p in pathVar.Split(';'))
                {
                    if (p.Trim().Length == 0) continue;
                    try { string c = Path.Combine(p.Trim(), "node.exe"); if (File.Exists(c)) return c; }
                    catch { /* PATH 里有非法项 */ }
                }
            }
            return null;
        }

        /// <summary>本机所有非回环 IPv4。</summary>
        internal static List<string> LocalIps()
        {
            List<string> ips = new List<string>();
            try
            {
                foreach (NetworkInterface ni in NetworkInterface.GetAllNetworkInterfaces())
                {
                    if (ni.OperationalStatus != OperationalStatus.Up) continue;
                    if (ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
                    foreach (UnicastIPAddressInformation u in ni.GetIPProperties().UnicastAddresses)
                    {
                        if (u.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                        ips.Add(u.Address.ToString());
                    }
                }
            }
            catch { /* 拿不到就算了 */ }
            return ips;
        }

        internal static string LanUrl(int port)
        {
            List<string> ips = LocalIps();
            return ips.Count > 0 ? "http://" + ips[0] + ":" + port : "";
        }

        internal static string LocalIp()
        {
            List<string> ips = LocalIps();
            return ips.Count > 0 ? ips[0] : "";
        }

        /// <summary>把用户输入的地址规整成 http(s)://host[:port]/；非法返回 null。</summary>
        internal static string NormalizeUrl(string s)
        {
            if (s == null) return null;
            s = s.Trim();
            if (s.Length == 0) return null;
            if (s.IndexOf("://") < 0) s = "http://" + s;
            try
            {
                Uri u = new Uri(s);
                if (u.Scheme != "http" && u.Scheme != "https") return null;
                if (string.IsNullOrEmpty(u.Host)) return null;
                return u.Scheme + "://" + u.Host + ":" + u.Port + "/";
            }
            catch { return null; }
        }

        internal static bool IsLoopbackUrl(string url)
        {
            try
            {
                string h = new Uri(url).Host.ToLowerInvariant();
                return h == "127.0.0.1" || h == "localhost" || h == "::1" || h == "[::1]" || h == "0.0.0.0";
            }
            catch { return false; }
        }

        /// <summary>局域网/回环地址（这些地址的证书问题不提示，直接放行）。</summary>
        internal static bool IsPrivateHost(string host)
        {
            if (string.IsNullOrEmpty(host)) return false;
            host = host.ToLowerInvariant();
            if (host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]") return true;
            if (host.StartsWith("10.") || host.StartsWith("192.168.") || host.StartsWith("169.254.")) return true;
            if (host.StartsWith("172."))
            {
                int dot = host.IndexOf('.', 4);
                int second;
                if (dot > 4 && int.TryParse(host.Substring(4, dot - 4), out second))
                    return second >= 16 && second <= 31;
            }
            return false;
        }

        internal static string HostPortOf(string url)
        {
            try
            {
                Uri u = new Uri(url);
                if (u.IsDefaultPort) return u.Host;
                return u.Host + ":" + u.Port;
            }
            catch { return url; }
        }

        /// <summary>从 shell.json / shell-state.json 里读一个字符串字段（够用就行的极简解析）。</summary>
        internal static string JsonStringValue(string file, string key)
        {
            try
            {
                if (!File.Exists(file)) return null;
                string text = File.ReadAllText(file);
                Match m = Regex.Match(text, "\"" + key + "\"\\s*:\\s*\"([^\"]*)\"");
                if (!m.Success) return null;
                return m.Groups[1].Value.Replace("\\\\", "\\").Replace("\\/", "/");
            }
            catch { return null; }
        }

        internal static void WriteState(string exeDir, string defaultServer, string trustedHostsCsv)
        {
            try
            {
                string file = Path.Combine(exeDir, "shell-state.json");
                string json = "{\n  \"defaultServer\": \"" + (defaultServer == null ? "" : defaultServer) + "\"" +
                              ",\n  \"trustedHosts\": \"" + (trustedHostsCsv == null ? "" : trustedHostsCsv) + "\"\n}\n";
                File.WriteAllText(file, json, new UTF8Encoding(false));
            }
            catch { /* 写不了就算了 */ }
        }
    }

    // ------------------------------------------------------------------

    /// <summary>「连接服务器」输入框。</summary>
    internal sealed class ConnectDialog : Form
    {
        private readonly TextBox box;
        private readonly CheckBox rememberBox;
        internal bool Remember { get { return rememberBox.Checked; } }
        internal string Address { get { return box.Text; } }

        internal ConnectDialog(string current)
        {
            Text = "连接服务器";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterParent;
            MaximizeBox = false; MinimizeBox = false;
            ClientSize = new Size(430, 172);
            Font = new Font("Microsoft YaHei UI", 9F);
            BackColor = Color.FromArgb(246, 247, 248);

            Label tip = new Label();
            tip.Text = "填服务器的地址（局域网 IP:端口，或完整网址）：";
            tip.SetBounds(14, 14, 400, 20);
            Controls.Add(tip);

            box = new TextBox();
            box.Text = current == null ? "" : current;
            box.SetBounds(14, 38, 400, 24);
            box.SelectAll();
            Controls.Add(box);

            Label eg = new Label();
            eg.Text = "例如  192.168.1.23:3000  或  https://frp-say.com:17763";
            eg.ForeColor = Color.FromArgb(110, 118, 124);
            eg.SetBounds(14, 66, 400, 18);
            Controls.Add(eg);

            rememberBox = new CheckBox();
            rememberBox.Text = "记住为默认（下次启动直接连它）";
            rememberBox.SetBounds(14, 90, 400, 22);
            Controls.Add(rememberBox);

            Button ok = new Button();
            ok.Text = "连接";
            ok.DialogResult = DialogResult.OK;
            ok.SetBounds(248, 124, 80, 28);
            Controls.Add(ok);

            Button cancel = new Button();
            cancel.Text = "取消";
            cancel.DialogResult = DialogResult.Cancel;
            cancel.SetBounds(334, 124, 80, 28);
            Controls.Add(cancel);

            AcceptButton = ok;
            CancelButton = cancel;
        }
    }

    // ------------------------------------------------------------------

    internal sealed class ShellForm : Form
    {
        private readonly Options opt;
        private readonly string exeDir;
        private WebView2 web;
        private StatusStrip status;
        private ToolStripStatusLabel lblServer;
        private ToolStripStatusLabel lblCopy;
        private ToolStripStatusLabel lblUpdate;
        private Process serverProc;
        private StreamWriter log;
        private string logPath;
        private string gameRoot;
        private string nodeExe;
        private string currentUrl;        // 窗口当前加载的 URL
        private string display;           // 标题里显示的地址（本机模式=局域网 IP:端口；远端=对方 host:port）
        private bool remoteTarget;        // true = 连的是别人的服务器
        private bool connected;           // 最近一次健康探测结果
        private bool weStartedServer;
        private string localIp = "";
        private int port;
        private int localServerPort;      // 本机服务端端口（0 = 本机没在开服）
        private System.Windows.Forms.Timer healthTimer;
        private bool busy;
        private string lastErrorShownFor;
        private int navAttempts;                 // 同一个地址已尝试次数
        private List<string> trustedHosts = new List<string>();   // 已接受其证书的服务器主机名
        private int certErrors;                                   // 自检报告用
        private System.Windows.Forms.Timer retryTimer;
        // 版本自检 / 一键更新（tools/update.mjs；服务端 /update/ 端点）
        private string updateSource = "";        // 更新源（--update-source > 环境变量 > shell.json > 连的服务器）
        private string updatePubkey = "";        // 发布方 ed25519 公钥文件（自签证书的链路上必须有）
        private string updateState = "";         // current / outdated / drifted / server-behind / error / unknown
        private string updateLatest = "";        // 发布方版本
        private string updateDrift = "";         // 不一致的文件数
        private string updateArtDrift = "";      // 素材是否与发布方一致（0/1）
        private bool updateBusy;
        private bool updateActionBusy;

        internal ShellForm(Options o)
        {
            opt = o;
            port = o.Port;
            exeDir = Path.GetDirectoryName(Application.ExecutablePath);
            Text = "卫戍协议：盟约";
            Width = 1360; Height = 840;
            MinimumSize = new Size(960, 600);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(12, 15, 14);
            // 命令行模式（--check-update / --update）不弹窗口：跑完写报告就退出
            if (o.CheckUpdate || o.DoUpdate) { ShowInTaskbar = false; Opacity = 0; WindowState = FormWindowState.Minimized; }
            BuildUi();
        }

        // ---------------- UI ----------------

        private void BuildUi()
        {
            MenuStrip menu = new MenuStrip();
            menu.BackColor = Color.FromArgb(18, 24, 22);
            menu.ForeColor = Color.FromArgb(200, 220, 214);

            ToolStripMenuItem mSet = new ToolStripMenuItem("设置(&S)");
            mSet.DropDownItems.Add(Item("联机服务器地址…(&S)", OnConnectServer));
            mSet.DropDownItems.Add(Item("连接本机服务器（自己开服）(&L)", OnConnectLocal));
            mSet.DropDownItems.Add(new ToolStripSeparator());
            mSet.DropDownItems.Add(Item("测试当前服务器连通性(&T)", OnTestServer));
            mSet.DropDownItems.Add(Item("清除记住的服务器(&C)", OnClearRemembered));
            mSet.DropDownItems.Add(Item("打开日志(&O)", OnOpenLog));
            mSet.DropDownItems.Add(new ToolStripSeparator());
            mSet.DropDownItems.Add(Item("检查更新(&U)…", OnCheckUpdateItem));
            mSet.DropDownItems.Add(Item("一键更新到最新(&F)…", OnUpdateClick));
            menu.Items.Add(mSet);

            ToolStripMenuItem mNet = new ToolStripMenuItem("联机(&N)");
            mNet.DropDownItems.Add(Item("复制本机联机地址(&C)", OnCopyLan));
            mNet.DropDownItems.Add(Item("用系统浏览器打开当前地址(&B)", OnOpenBrowser));
            mNet.DropDownItems.Add(Item("重新探测局域网地址(&R)", OnRescanLan));
            menu.Items.Add(mNet);

            ToolStripMenuItem mView = new ToolStripMenuItem("视图(&V)");
            mView.DropDownItems.Add(Item("刷新(&F5)", OnRefresh));
            mView.DropDownItems.Add(Item("全屏(&F11)", OnFullscreen));
            menu.Items.Add(mView);

            ToolStripMenuItem mHelp = new ToolStripMenuItem("帮助(&H)");
            mHelp.DropDownItems.Add(Item("打开游戏目录(&G)", OnOpenGameDir));
            mHelp.DropDownItems.Add(Item("打开日志(&L)", OnOpenLog));
            mHelp.DropDownItems.Add(new ToolStripSeparator());
            mHelp.DropDownItems.Add(Item("关于(&A)", OnAbout));
            menu.Items.Add(mHelp);

            status = new StatusStrip();
            status.BackColor = Color.FromArgb(18, 24, 22);
            lblServer = new ToolStripStatusLabel("正在启动…");
            lblServer.ForeColor = Color.FromArgb(190, 210, 204);
            lblCopy = new ToolStripStatusLabel("");
            lblCopy.ForeColor = Color.FromArgb(126, 226, 192);
            lblCopy.IsLink = true;
            lblCopy.Click += OnCopyLan;
            lblUpdate = new ToolStripStatusLabel("");
            lblUpdate.ForeColor = Color.FromArgb(250, 214, 120);
            lblUpdate.IsLink = true;
            lblUpdate.Click += OnUpdateClick;
                        status.Items.Add(lblServer);
                        status.Items.Add(new ToolStripStatusLabel("   "));
                        status.Items.Add(lblCopy);
                        status.Items.Add(new ToolStripStatusLabel("  点击地址可复制") { ForeColor = Color.FromArgb(120, 140, 134) });
                        status.Items.Add(new ToolStripStatusLabel("   "));
                        status.Items.Add(lblUpdate);

            web = new WebView2();
            web.Dock = DockStyle.Fill;
            web.DefaultBackgroundColor = Color.FromArgb(12, 15, 14);
            web.NavigationCompleted += OnNavigationCompleted;

            Controls.Add(web);      // Fill
            Controls.Add(status);   // Bottom
            Controls.Add(menu);     // Top（最后添加 → 先占位）
            MainMenuStrip = menu;

            healthTimer = new System.Windows.Forms.Timer();
            healthTimer.Interval = 4000;
            healthTimer.Tick += async delegate(object s, EventArgs e) { await PollAsync(); };
        }

        private static ToolStripMenuItem Item(string text, EventHandler h)
        {
            ToolStripMenuItem it = new ToolStripMenuItem(text);
            it.Click += h;
            return it;
        }

        private void AppendLog(string line)
        {
            try { if (log != null) { log.WriteLine(line); log.Flush(); } } catch { /* 磁盘忙 */ }
        }

        /// <summary>标题/状态栏的唯一出口：连上谁就显示谁；没连上就显示本机 IP。</summary>
        private void UpdateChrome()
        {
            string titleAddr;
            if (connected) titleAddr = display;
            else titleAddr = localIp.Length > 0 ? localIp : display;
            Text = string.IsNullOrEmpty(titleAddr) ? "卫戍协议：盟约" : "卫戍协议：盟约 · " + titleAddr;

            if (connected)
                lblServer.Text = (remoteTarget ? "已连接 · 远端 " : "已连接 · 本机 ") + display;
            else
                lblServer.Text = "未连接" + (localIp.Length > 0 ? "（本机 IP " + localIp + "）" : "");

            if (localServerPort != 0 && !remoteTarget)
                lblCopy.Text = localIp.Length > 0 ? "本机联机地址 http://" + localIp + ":" + localServerPort : "";
            else if (localServerPort != 0)
                lblCopy.Text = localIp.Length > 0 ? "本机联机地址 http://" + localIp + ":" + localServerPort : "";
            else
                lblCopy.Text = localIp.Length > 0 ? "本机 IP " + localIp : "";

                if (lblUpdate != null) lblUpdate.Text = UpdateStatusText();
        }

        private string CopyTarget()
        {
            if (localServerPort != 0 && localIp.Length > 0) return "http://" + localIp + ":" + localServerPort;
            if (localIp.Length > 0) return localIp;
            return currentUrl;
        }

        // ---------------- 版本自检 / 一键更新（tools/update.mjs + 服务端 /update/ 端点） ----------------

        /// <summary>更新源：--update-source &gt; SP_UPDATE_SOURCE &gt; shell.json updateSource &gt; 当前连的服务器 &gt; 记住的服务器。</summary>
        private string ResolveUpdateSource()
        {
            if (!string.IsNullOrEmpty(opt.UpdateSource)) return opt.UpdateSource.Trim().TrimEnd('/');
            string env = Environment.GetEnvironmentVariable("SP_UPDATE_SOURCE");
            if (!string.IsNullOrEmpty(env)) return env.Trim().TrimEnd('/');
            string cfg = Path.Combine(exeDir, "shell.json");
            string s = Program.JsonStringValue(cfg, "updateSource");
            if (!string.IsNullOrEmpty(s)) return s.Trim().TrimEnd('/');
            if (remoteTarget && !string.IsNullOrEmpty(currentUrl)) return currentUrl.TrimEnd('/');
            s = Program.JsonStringValue(Path.Combine(exeDir, "shell-state.json"), "defaultServer");
            if (!string.IsNullOrEmpty(s)) return s.Trim().TrimEnd('/');
            s = Program.JsonStringValue(cfg, "server");
            if (!string.IsNullOrEmpty(s)) return s.Trim().TrimEnd('/');
            return "";
        }

        /// <summary>发布方公钥：--pubkey &gt; shell.json updatePubkey &gt; exe 旁的 update-pubkey.pem。</summary>
        private string ResolveUpdatePubkey()
        {
            if (!string.IsNullOrEmpty(opt.UpdatePubkey)) return opt.UpdatePubkey;
            string s = Program.JsonStringValue(Path.Combine(exeDir, "shell.json"), "updatePubkey");
            if (!string.IsNullOrEmpty(s)) return Path.IsPathRooted(s) ? s : Path.Combine(exeDir, s);
            string p = Path.Combine(exeDir, "update-pubkey.pem");
            if (File.Exists(p)) return p;
            if (!string.IsNullOrEmpty(gameRoot))
            {
                p = Path.Combine(Path.GetDirectoryName(gameRoot), "update-pubkey.pem");
                if (File.Exists(p)) return p;
            }
            return "";
        }

        /// <summary>跑一次 node（tools/update.mjs），拿回 stdout。超时也会返回已经读到的内容。</summary>
        private async Task<string> RunNodeAsync(string args, int timeoutMs)
        {
            if (string.IsNullOrEmpty(nodeExe)) return null;
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(nodeExe, args);
                psi.WorkingDirectory = string.IsNullOrEmpty(gameRoot) ? exeDir : gameRoot;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                Process p = new Process();
                p.StartInfo = psi;
                if (!p.Start()) { AppendLog("[update] node 起不来"); return null; }
                Task<string> outTask = p.StandardOutput.ReadToEndAsync();
                Task<string> errTask = p.StandardError.ReadToEndAsync();
                await Task.Run(delegate() { p.WaitForExit(timeoutMs); });
                bool exited = p.HasExited;
                try { if (!exited) p.Kill(); } catch { /* 已退出 */ }
                string outp = await outTask;
                string err = await errTask;
                if (!string.IsNullOrEmpty(err)) AppendLog("[update!] " + err.Replace("\r", " ").Replace("\n", " "));
                AppendLog("[update] node " + (exited ? "exit=" + p.ExitCode : "超时"));
                return outp;
            }
            catch (Exception ex) { AppendLog("[update] 运行 node 失败：" + ex.Message); return null; }
        }

        /// <summary>tools/update.mjs 的参数（同一个游戏目录、同一个更新源、同一个公钥）。</summary>
        private string UpdateCliArgs(bool apply)
        {
            string args = "\"" + Path.Combine(gameRoot, "tools", "update.mjs") + "\" " + (apply ? "apply" : "check")
                + " --root \"" + gameRoot + "\" --json";
            if (updateSource.Length > 0) args += " --source \"" + updateSource + "\"";
                        if (updatePubkey.Length > 0) args += " --pubkey \"" + updatePubkey + "\"";
                        // 自签证书的隧道（SakuraFrp 之类）默认校验不过：更新通道的可信度由发布方签名保证，
                        // 所以 https 源只要配了公钥就跳过 TLS 校验（update.mjs 也不允许只 --insecure 不给公钥）。
                        if (updateSource.StartsWith("https://", StringComparison.OrdinalIgnoreCase) && updatePubkey.Length > 0) args += " --insecure";
                        if (apply && opt.UpdateNoSetup) args += " --no-setup";
            return args;
        }

        /// <summary>后台自检：连不上、读不到发布信息都静默（不能因为更新源挂了就不让玩）。</summary>
        private async Task CheckUpdateAsync()
        {
            if (updateBusy || string.IsNullOrEmpty(gameRoot) || string.IsNullOrEmpty(updateSource)) return;
            updateBusy = true;
            try
            {
                string json = await RunNodeAsync(UpdateCliArgs(false), 8000);
                ApplyUpdateJson(json);
            }
            catch (Exception ex) { AppendLog("[update] 自检失败：" + ex.Message); }
            finally { updateBusy = false; UpdateChrome(); }
        }

        private void ApplyUpdateJson(string json)
        {
            if (string.IsNullOrEmpty(json)) { updateState = "unknown"; return; }
            string st = JsonField(json, "state");
            updateState = string.IsNullOrEmpty(st) ? "unknown" : st;
            updateLatest = JsonField(json, "latest");
            if (updateLatest == null) updateLatest = "";
            updateDrift = JsonField(json, "drift");
            if (updateDrift == null) updateDrift = "";
            updateArtDrift = JsonField(json, "artDrift");
            if (updateArtDrift == null) updateArtDrift = "";
            AppendLog("[update] state=" + updateState + " app=" + JsonField(json, "app") + " latest=" + updateLatest
                + " drift=" + updateDrift + " art=" + updateArtDrift + " sig=" + JsonField(json, "signatureOk"));
        }

        /// <summary>本机版本（读 app\package.json 的 version）。</summary>
        private string LocalVersion()
        {
            if (string.IsNullOrEmpty(gameRoot)) return "";
            try
            {
                string t = File.ReadAllText(Path.Combine(gameRoot, "package.json"), Encoding.UTF8);
                int i = t.IndexOf("\"version\"", StringComparison.Ordinal);
                if (i < 0) return "";
                int c = t.IndexOf(':', i);
                if (c < 0) return "";
                int q1 = t.IndexOf('"', c + 1);
                if (q1 < 0) return "";
                int q2 = t.IndexOf('"', q1 + 1);
                if (q2 <= q1) return "";
                return t.Substring(q1 + 1, q2 - q1 - 1);
            }
            catch { return ""; }
        }

        /// <summary>状态栏右侧那段字：版本 + 更新提示（可点击 = 一键更新）。</summary>
        private string UpdateStatusText()
        {
            string local = LocalVersion();
            if (updateState.Length == 0) return local.Length > 0 ? "v" + local : "";
            if (updateState == "outdated") return "有新版本 v" + updateLatest + "（本机 v" + local + "）· 点此一键更新";
            if (updateState == "drifted") return "内容与服务器不一致（" + (updateDrift.Length > 0 ? updateDrift : "?") + " 个文件）· 点此一键更新";
            if (updateState == "current") return "v" + local + " · 已是最新" + (updateArtDrift == "1" ? "（素材不一致，跑 setup 补）" : "");
            if (updateState == "server-behind") return "v" + local + " · 比发布方新";
            return local.Length > 0 ? "v" + local : "";
        }

        /// <summary>停掉本机自己起的服务端：更新前必须停（正被 node 加载的模块文件换不掉，换了也会读到半个版本）。</summary>
        private void StopOwnServer()
        {
            try
            {
                if (weStartedServer && serverProc != null && !serverProc.HasExited)
                {
                    AppendLog("[shell] killing node pid=" + serverProc.Id + "（更新前停服）");
                    try
                    {
                        ProcessStartInfo psi = new ProcessStartInfo("taskkill", "/PID " + serverProc.Id + " /T /F");
                        psi.UseShellExecute = false;
                        psi.CreateNoWindow = true;
                        Process.Start(psi).WaitForExit(5000);
                    }
                    catch { try { serverProc.Kill(); } catch { /* 已退出 */ } }
                }
            }
            catch (Exception ex) { AppendLog("[shell] 停服失败：" + ex.Message); }
            serverProc = null;
            weStartedServer = false;
            localServerPort = 0;
        }

        /// <summary>一键更新：状态栏提示、菜单、--update 都走这里（先停服 → 跑 node tools/update.mjs apply → 重启窗口）。</summary>
        private async void OnUpdateClick(object sender, EventArgs e)
        {
            if (updateActionBusy) return;
            if (string.IsNullOrEmpty(gameRoot) || string.IsNullOrEmpty(nodeExe))
            {
                MessageBox.Show(this, "找不到游戏本体（app\\server\\index.js）或 node.exe，不能更新。", "一键更新", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (updateSource.Length == 0)
            {
                MessageBox.Show(this, "还没有更新源。\n\n连一次服务器（设置 → 联机服务器地址…），\n或在 shell.json 里写 { \"updateSource\": \"https://你的服务器:端口\" }",
                    "一键更新", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            string target = updateLatest.Length > 0 ? ("v" + updateLatest) : "最新版本";
            string what = updateState == "drifted"
                ? "本机与服务器内容不一致（" + (updateDrift.Length > 0 ? updateDrift : "?") + " 个文件），会把不一致的同步过来"
                : ("更新到 " + target);
            if (MessageBox.Show(this, what + "。\n\n会先停掉本机服务端；存档在 %LOCALAPPDATA%\\StrongholdShell，不受影响。\n继续？",
                    "一键更新", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) != DialogResult.OK) return;

            updateActionBusy = true;
            lblServer.Text = "正在更新…";
            AppendLog("[update] 一键更新开始：source=" + updateSource);
            try
            {
                StopOwnServer();
                string json = await RunNodeAsync(UpdateCliArgs(true), 900000);
                ApplyUpdateJson(json);
                string ok = JsonField(json, "ok");
                string err = JsonField(json, "error");
                string after = JsonField(json, "after");
                if (ok == "true" || ok == "True")
                {
                    AppendLog("[update] 更新成功：" + after);
                    MessageBox.Show(this, "已更新到 v" + (string.IsNullOrEmpty(after) ? updateLatest : after) + "。\n\n重新启动窗口…",
                        "一键更新", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    Application.Restart();
                    return;
                }
                MessageBox.Show(this, "更新没有完成：\n\n" + (string.IsNullOrEmpty(err) ? "见 shell.log" : err)
                    + "\n\n可以手动下载完整包覆盖安装。", "一键更新", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "更新出错：" + ex.Message, "一键更新", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally { updateActionBusy = false; UpdateChrome(); }
        }

        private async void OnCheckUpdateItem(object sender, EventArgs e)
        {
            if (updateSource.Length == 0)
            {
                MessageBox.Show(this, "还没有更新源。连一次服务器，或在 shell.json 里写 updateSource。", "检查更新", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            lblUpdate.Text = "正在检查…";
            await CheckUpdateAsync();
            if (updateState == "current")
                MessageBox.Show(this, "v" + LocalVersion() + " 已是最新（内容也与服务器一致）。", "检查更新", MessageBoxButtons.OK, MessageBoxIcon.Information);
            else if (updateState == "outdated")
                MessageBox.Show(this, "服务器有新版本 v" + updateLatest + "（本机 v" + LocalVersion() + "）。\n\n设置 → 一键更新到最新。", "检查更新", MessageBoxButtons.OK, MessageBoxIcon.Information);
            else if (updateState == "drifted")
                MessageBox.Show(this, "版本号一样，但内容有 " + updateDrift + " 个文件与服务器不同。\n\n设置 → 一键更新到最新。", "检查更新", MessageBoxButtons.OK, MessageBoxIcon.Information);
            else if (updateState == "server-behind")
                MessageBox.Show(this, "本机 v" + LocalVersion() + " 比发布方 v" + updateLatest + " 还新，不更新。", "检查更新", MessageBoxButtons.OK, MessageBoxIcon.Information);
            else
                MessageBox.Show(this, "检查失败（见 shell.log）。\n更新源：" + updateSource, "检查更新", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }

        /// <summary>命令行模式（--check-update / --update）：跑完写 JSON 报告再退出。</summary>
        private async Task RunUpdateCliAsync()
        {
            if (string.IsNullOrEmpty(gameRoot) || string.IsNullOrEmpty(nodeExe))
            {
                WriteUpdateReport("{\n  \"ok\": false,\n  \"state\": \"error\",\n  \"error\": \"找不到游戏本体（app\\\\server\\\\index.js）或 node.exe\"\n}\n");
                Application.Exit();
                return;
            }
            if (opt.DoUpdate) StopOwnServer();
            string json = await RunNodeAsync(UpdateCliArgs(opt.DoUpdate), opt.DoUpdate ? 900000 : 30000);
            WriteUpdateReport(string.IsNullOrEmpty(json)
                ? "{\n  \"ok\": false,\n  \"state\": \"error\",\n  \"error\": \"node 没有输出（见 shell.log）\"\n}\n"
                : json);
            Application.Exit();
        }

        private void WriteUpdateReport(string text)
        {
            string p = opt.SmokeOut;
            if (string.IsNullOrEmpty(p)) p = Path.Combine(exeDir, "update-report.json");
            try { File.WriteAllText(p, text, new UTF8Encoding(false)); AppendLog("[update] report → " + p); }
            catch (Exception ex) { AppendLog("[update] 写报告失败：" + ex.Message); }
            try { Console.Out.WriteLine(text); Console.Out.Flush(); } catch { /* winexe 没有控制台 */ }
        }

        /// <summary>tools/update.mjs --json 的输出是扁平的：取一个字段（字符串 / 数字 / true / false）。</summary>
        private static string JsonField(string json, string key)
        {
            if (string.IsNullOrEmpty(json)) return null;
            int i = json.IndexOf("\"" + key + "\"", StringComparison.Ordinal);
            if (i < 0) return null;
            int c = json.IndexOf(':', i + key.Length + 2);
            if (c < 0) return null;
            int p = c + 1;
            while (p < json.Length && char.IsWhiteSpace(json[p])) p++;
            if (p >= json.Length) return null;
            if (json[p] == '"')
            {
                int e = p + 1;
                while (e < json.Length && json[e] != '"') { if (json[e] == '\\') e++; e++; }
                if (e >= json.Length) return null;
                return json.Substring(p + 1, e - p - 1).Replace("\\\"", "\"").Replace("\\\\", "\\").Replace("\\/", "/");
            }
            int end = p;
            while (end < json.Length && json[end] != ',' && json[end] != '}' && json[end] != '\n') end++;
            return json.Substring(p, end - p).Trim();
        }

        // ---------------- 启动流程 ----------------

        protected override async void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            logPath = Path.Combine(exeDir, "shell.log");
            try { log = new StreamWriter(logPath, true, new UTF8Encoding(false)); } catch { log = null; }
            AppendLog("=== " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " shell start ===");
            localIp = Program.LocalIp();
            AppendLog("[shell] localIp = " + localIp);

            string stateFile = Path.Combine(exeDir, "shell-state.json");
            string csv = Program.JsonStringValue(stateFile, "trustedHosts");
            if (!string.IsNullOrEmpty(csv))
                foreach (string h in csv.Split(','))
                    if (h.Trim().Length > 0) trustedHosts.Add(h.Trim().ToLowerInvariant());
            AppendLog("[shell] trustedHosts = " + (trustedHosts.Count == 0 ? "(空)" : string.Join(",", trustedHosts.ToArray())));

            // .NET 侧的健康探测同样要接受这些证书，否则状态栏会显示「未连接」而页面其实是好的
                        try { ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; } catch { }   // 至少 TLS 1.2（自签 https 服务端不接受更低的）
                        ServicePointManager.ServerCertificateValidationCallback =
                            delegate(object sender, System.Security.Cryptography.X509Certificates.X509Certificate cert,
                                     System.Security.Cryptography.X509Certificates.X509Chain chain,
                                     System.Net.Security.SslPolicyErrors errors)
                            {
                                if (errors == System.Net.Security.SslPolicyErrors.None) return true;
                                HttpWebRequest r = sender as HttpWebRequest;
                                // 必须用 RequestUri：HttpWebRequest.Address 在请求真正发出前是 null，用它会让回调自己抛异常，
                                // 表现就是「未能创建 SSL/TLS 安全通道」→ 状态栏永远「未连接」。
                                string host = (r != null && r.RequestUri != null) ? r.RequestUri.Host.ToLowerInvariant() : "";
                                if (host.Length == 0) return false;
                                return trustedHosts.Contains(host) || Program.IsPrivateHost(host) || opt.Smoke;
                            };

            gameRoot = Program.ResolveGameRoot(opt);
            nodeExe = gameRoot == null ? null : Program.ResolveNode(gameRoot);
            if (gameRoot != null) AppendLog("[shell] gameRoot = " + gameRoot);
                        if (nodeExe != null) AppendLog("[shell] node = " + nodeExe);

                        // 版本自检 / 一键更新（命令行模式：跑完写报告就退出，不弹窗口、不动 WebView2）
                        if (opt.CheckUpdate || opt.DoUpdate)
                        {
                            updateSource = ResolveUpdateSource();
                            updatePubkey = ResolveUpdatePubkey();
                            AppendLog("[update] source = " + (updateSource.Length == 0 ? "(空)" : updateSource));
                            await RunUpdateCliAsync();
                            return;
                        }

            // WebView2 运行时（系统 Edge 内核）是否存在
            string wv2 = null;
            try { wv2 = CoreWebView2Environment.GetAvailableBrowserVersionString(); }
            catch (Exception) { wv2 = null; }
            if (wv2 == null)
            {
                string url = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
                DialogResult r = MessageBox.Show(this,
                    "系统里没有 WebView2 运行时（Edge 内核）。\n\n" +
                    "Win11 自带；Win10 一般随 Edge 装好。\n" +
                    "如果确实缺失，点「是」打开微软官方安装包页面（约 2 MB，装一次即可）。\n\n" +
                    "也可以点「否」用系统默认浏览器打开游戏（不需要内核）。",
                    "缺少浏览器内核", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Warning);
                if (r == DialogResult.Yes) { try { Process.Start(url); } catch { } }
                else if (r == DialogResult.No)
                {
                    string cli = await EnsureLocalServerAsync();
                    if (cli != null) { try { Process.Start(cli); } catch { } }
                }
                Close();
                return;
            }
            AppendLog("[shell] WebView2 runtime = " + wv2);

            try
            {
                CoreWebView2CreationProperties props = new CoreWebView2CreationProperties();
                props.UserDataFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "StrongholdShell", "WebView2");
                // 代理不动（跟随系统设置，与系统浏览器一致）。
                // 注：实测 WebView2 首次导航到局域网地址时，可能因为系统代理的异步解析被 abort
                // （ERR_CONNECTION_ABORTED）；--proxy-bypass-list / --no-proxy-server 都不解决，
                // 改成「失败自动重试」就正常了（见 OnNavigationCompleted）。
                web.CreationProperties = props;
                await web.EnsureCoreWebView2Async(null);
            }
            catch (Exception ex)
            {
                Fail("WebView2 初始化失败：\n" + ex.Message);
                return;
            }
            web.CoreWebView2.Settings.IsStatusBarEnabled = false;
            web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
            web.CoreWebView2.Settings.AreDevToolsEnabled = true;
            web.CoreWebView2.NewWindowRequested += OnNewWindow;
            // 自签名 / 不受信任证书（frp 隧道很常见）：浏览器会弹「是否继续」，WebView2 没有 UI，
            // 必须在 ServerCertificateErrorDetected 里替用户决定，否则导航直接失败。
            web.CoreWebView2.ServerCertificateErrorDetected += OnCertError;
            web.CoreWebView2.NavigateToString(WaitingPage("正在启动…"));

            // 目标服务器：命令行 --connect > shell-state.json 记住的 > shell.json 的 server > 本机模式
            string target = null;
            if (!opt.ForceLocal)
            {
                if (!string.IsNullOrEmpty(opt.Connect)) target = Program.NormalizeUrl(opt.Connect);
                if (target == null) target = Program.NormalizeUrl(Program.JsonStringValue(Path.Combine(exeDir, "shell-state.json"), "defaultServer"));
                if (target == null) target = Program.NormalizeUrl(Program.JsonStringValue(Path.Combine(exeDir, "shell.json"), "server"));
            }

            if (target != null && !Program.IsLoopbackUrl(target))
            {
                AppendLog("[shell] remote target = " + target);
                await NavigateRemoteAsync(target);
            }
            else
            {
                if (target != null) AppendLog("[shell] target " + target + " 是本机 → 本机模式");
                string cli = await EnsureLocalServerAsync();
                if (cli == null) return;
            }

            UpdateChrome();
            healthTimer.Start();
            if (opt.Smoke) await RunSmokeAsync();
            else
            {
            // 版本自检：静默（更新源挂了、连不上都不该影响玩）
            updateSource = ResolveUpdateSource();
            updatePubkey = ResolveUpdatePubkey();
            if (updateSource.Length > 0)
            {
            AppendLog("[update] source = " + updateSource + (updatePubkey.Length > 0 ? "，公钥 " + updatePubkey : "（没有公钥：只报警，不自动接受）"));
            await CheckUpdateAsync();
            }
            else AppendLog("[update] 没有更新源，跳过版本自检（连一次服务器，或在 shell.json 写 updateSource）");
                        }
        }

        private void Fail(string message)
        {
            AppendLog("[shell] FAIL " + message.Replace("\n", " "));
            lblServer.Text = "启动失败";
            if (opt.Smoke) { WriteSmokeReport("{\n  \"ok\": false,\n  \"shell\": \"thin/webview2\",\n  \"error\": " + Json(message) + "\n}\n"); Application.Exit(); return; }
            MessageBox.Show(this, message, "启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }

        /// <summary>本机模式：复用已有服务端或自己起一个；成功后加载 http://127.0.0.1:port/。返回该 URL。</summary>
        private async Task<string> EnsureLocalServerAsync()
        {
            if (gameRoot == null)
            {
                Fail("找不到游戏本体（app\\server\\index.js）。\n\n" +
                     "把这个 exe 放到便携包根目录（和 app\\、node\\ 同级），\n" +
                     "或者用 --game <app目录> 指定，或在本 exe 旁写一个 shell.json：\n" +
                     "  { \"gameRoot\": \"D:\\\\path\\\\to\\\\app\", \"port\": 3000 }\n\n" +
                     "只想连别人的服务器？用「联机 → 连接服务器…」或 --connect <地址>，本机不需要游戏本体。");
                return null;
            }
            if (nodeExe == null)
            {
                Fail("找不到 node.exe。请把它放进便携包的 node\\ 目录（官方便携包自带），\n或安装 Node 22+ 后把 node 加进 PATH。");
                return null;
            }

            int start = opt.Port;
            for (int i = 0; i < 11; i++)
            {
                int p = i < 10 ? start + i : 0;
                if (p != 0 && await HealthAsync("http://127.0.0.1:" + p + "/", 600))   // 已有服务端 → 复用
                {
                    localServerPort = p; weStartedServer = false;
                    await LoadAsync("http://127.0.0.1:" + p + "/", true);
                    AppendLog("[shell] reuse existing local server on " + p);
                    return currentUrl;
                }
                if (p != 0 && !PortFree(p)) continue;                                 // 被别的程序占着 → 换端口
                if (!await StartServerAsync(p)) continue;
                localServerPort = p;
                await LoadAsync("http://127.0.0.1:" + p + "/", true);
                return currentUrl;
            }
            if (await HealthAsync("http://127.0.0.1:" + start + "/", 1200))
            {
                localServerPort = start;
                await LoadAsync("http://127.0.0.1:" + start + "/", true);
                return currentUrl;
            }
            Fail("端口 " + start + "–" + (start + 9) + " 都被占用，起不来游戏服务端。\n" +
                 "先关掉上一个实例（或改端口：StrongholdShell.exe --port 3010）。");
            return null;
        }

        private static bool PortFree(int p)
        {
            TcpListener l = null;
            try { l = new TcpListener(IPAddress.Any, p); l.Start(); return true; }
            catch (SocketException) { return false; }
            finally { if (l != null) { try { l.Stop(); } catch { } } }
        }

        private async Task<bool> StartServerAsync(int p)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(nodeExe, "\"" + Path.Combine(gameRoot, "server", "index.js") + "\"");
                psi.WorkingDirectory = gameRoot;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.EnvironmentVariables["PORT"] = p.ToString();
                psi.EnvironmentVariables["HOST"] = "0.0.0.0";
                serverProc = new Process();
                serverProc.StartInfo = psi;
                serverProc.OutputDataReceived += delegate(object s, DataReceivedEventArgs ev) { if (ev.Data != null) AppendLog("[node] " + ev.Data); };
                serverProc.ErrorDataReceived += delegate(object s, DataReceivedEventArgs ev) { if (ev.Data != null) AppendLog("[node!] " + ev.Data); };
                if (!serverProc.Start()) { AppendLog("[shell] node start returned false"); return false; }
                serverProc.BeginOutputReadLine();
                serverProc.BeginErrorReadLine();
                weStartedServer = true;
                AppendLog("[shell] spawned node pid=" + serverProc.Id + " port=" + p);
            }
            catch (Exception ex)
            {
                AppendLog("[shell] spawn failed: " + ex.Message);
                return false;
            }
            for (int i = 0; i < 100; i++)                      // 最多等 ~30s
            {
                if (await HealthAsync("http://127.0.0.1:" + p + "/", 700)) return true;
                if (serverProc.HasExited) { AppendLog("[shell] node exited early, code=" + serverProc.ExitCode); return false; }
                await Task.Delay(300);
            }
            AppendLog("[shell] health timeout on port " + p);
            return false;
        }

        private static async Task<bool> HealthAsync(string url, int timeoutMs)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(new Uri(new Uri(url), "/healthz").ToString());
                req.Proxy = null;              // 同 WebView2：健康探测也直连，别走系统代理
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                req.Method = "GET";
                using (WebResponse resp = await req.GetResponseAsync())
                using (StreamReader sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    string body = await sr.ReadToEndAsync();
                    return body.IndexOf("\"ok\":true", StringComparison.OrdinalIgnoreCase) >= 0;
                }
            }
            catch { return false; }
        }

        /// <summary>本机模式：加载本机服务端。标题显示局域网 IP:端口（给朋友的那个）。</summary>
        private async Task LoadAsync(string url, bool local)
        {
            currentUrl = url;
            lastErrorShownFor = null;
            navAttempts = 0;
            remoteTarget = !local;
            display = local
                ? (localIp.Length > 0 ? localIp + ":" + localServerPort : "127.0.0.1:" + localServerPort)
                : Program.HostPortOf(url);
            AppendLog("[shell] navigate " + url + "  (display " + display + ")");
            if (web.CoreWebView2 != null) web.CoreWebView2.Navigate(url);
            UpdateChrome();
            connected = await HealthAsync(url, 1500);
            UpdateChrome();
        }

        /// <summary>远端模式：只把窗口指向别人的服务器，本机不起任何服务。</summary>
        private async Task NavigateRemoteAsync(string url)
        {
            localServerPort = 0;
            await LoadAsync(url, false);
            if (!connected)
                AppendLog("[shell] 远端 " + url + " 暂时没回应（页面里仍会不断重连）");
        }

        private async Task PollAsync()
        {
            if (currentUrl == null) return;
            bool ok = await HealthAsync(currentUrl, 1500);
            if (ok != connected) { connected = ok; UpdateChrome(); AppendLog("[shell] connection " + (ok ? "up" : "down") + " " + currentUrl); }
        }

        // ---------------- 事件 ----------------

        /// <summary>服务器证书不受信任时：局域网地址直接放行；公网地址问一次并记住。</summary>
        private void OnCertError(object sender, CoreWebView2ServerCertificateErrorDetectedEventArgs e)
        {
            certErrors++;
            string host = "";
            try { host = new Uri(e.RequestUri).Host.ToLowerInvariant(); } catch { }
            bool allow = trustedHosts.Contains(host) || Program.IsPrivateHost(host);
            AppendLog("[shell] 证书错误 " + e.ErrorStatus + " host=" + host + " allow=" + allow + " url=" + e.RequestUri);

            if (!allow)
            {
                if (opt.Smoke)
                {
                    allow = true;                       // 自检无人值守：直接信任，报告里留痕
                    AppendLog("[smoke] 自动信任证书 host=" + host);
                }
                else
                {
                    DialogResult r = MessageBox.Show(this,
                        "服务器 " + host + " 的证书不受信任：\n\n" + e.ErrorStatus + "\n\n" +
                        "这是你正在连的联机服务器吗？（自建 / frp 隧道常用自签名证书，正常）\n" +
                        "点「是」继续访问，并记住这个服务器；点「否」取消。",
                        "服务器证书不受信任", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                    allow = (r == DialogResult.Yes);
                }
                if (allow && host.Length > 0)
                {
                    trustedHosts.Add(host);
                    SaveTrustedHosts();
                }
            }
            try { e.Action = allow ? CoreWebView2ServerCertificateErrorAction.AlwaysAllow : CoreWebView2ServerCertificateErrorAction.Cancel; }
            catch { /* 旧运行时没有 Action，忽略 */ }
        }

        private void SaveTrustedHosts()
        {
            string def = Program.JsonStringValue(Path.Combine(exeDir, "shell-state.json"), "defaultServer");
            Program.WriteState(exeDir, def, string.Join(",", trustedHosts.ToArray()));
        }

        /// <summary>设置 → 测试当前服务器连通性。</summary>
        private async void OnTestServer(object sender, EventArgs e)
        {
            if (currentUrl == null) { MessageBox.Show(this, "还没有连接任何服务器。", "测试", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
            lblCopy.Text = "测试中…";
            bool ok = await HealthAsync(currentUrl, 4000);
            StringBuilder sb = new StringBuilder();
            sb.Append("服务器：").Append(currentUrl).Append("\n");
            sb.Append("模式：").Append(remoteTarget ? "远端（别人的服务器）" : "本机").Append("\n");
            sb.Append("/healthz：").Append(ok ? "正常" : "无响应").Append("\n");
            sb.Append("已信任证书的主机：").Append(trustedHosts.Count == 0 ? "（无）" : string.Join(", ", trustedHosts.ToArray())).Append("\n");
            sb.Append("本机 IP：").Append(localIp);
            MessageBox.Show(this, sb.ToString(), "服务器连通性", MessageBoxButtons.OK, ok ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
            UpdateChrome();
        }

        /// <summary>设置 → 清除记住的服务器（下次启动回到本机模式）。</summary>
        private void OnClearRemembered(object sender, EventArgs e)
        {
            Program.WriteState(exeDir, "", string.Join(",", trustedHosts.ToArray()));
            MessageBox.Show(this, "已清除记住的服务器地址（证书信任记录保留）。\n下次启动回到「本机服务器」模式。", "设置", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        private void OnNewWindow(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            e.Handled = true;
            try { Process.Start(e.Uri); } catch { }
        }

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs e)
        {
            if (e.IsSuccess)
            {
                lastErrorShownFor = null;
                navAttempts = 0;
                return;
            }
            AppendLog("[shell] navigation failed: " + e.WebErrorStatus + " " + currentUrl);
            connected = false;
            UpdateChrome();
            // 第一次导航可能因为系统代理的异步解析被 abort（局域网地址尤其明显），重试几次即可
            if (navAttempts < 3 && currentUrl != null && web.CoreWebView2 != null)
            {
                navAttempts++;
                AppendLog("[shell] 重试导航 #" + navAttempts + " → " + currentUrl);
                try { if (retryTimer != null) { retryTimer.Stop(); retryTimer.Dispose(); } } catch { }
                retryTimer = new System.Windows.Forms.Timer();
                retryTimer.Interval = 900;
                retryTimer.Tick += delegate(object s2, EventArgs e2)
                {
                    retryTimer.Stop();
                    try { web.CoreWebView2.Navigate(currentUrl); } catch { }
                };
                retryTimer.Start();
                return;
            }
            // 同一个地址只贴一次错误页，避免失败重试时反复注入
            if (lastErrorShownFor == currentUrl) return;
            lastErrorShownFor = currentUrl;
            if (!opt.RawError && web.CoreWebView2 != null && currentUrl != null)
                web.CoreWebView2.NavigateToString(ErrorPage(currentUrl, e.WebErrorStatus.ToString()));
        }

        private async void OnConnectServer(object sender, EventArgs e)
        {
            using (ConnectDialog dlg = new ConnectDialog(currentUrl))
            {
                if (dlg.ShowDialog(this) != DialogResult.OK) return;
                string url = Program.NormalizeUrl(dlg.Address);
                if (url == null)
                {
                    MessageBox.Show(this, "地址写得不合法。\n例如：192.168.1.23:3000 或 http://example.com:3000", "连接服务器", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }
                if (dlg.Remember) Program.WriteState(exeDir, url, string.Join(",", trustedHosts.ToArray()));
                if (Program.IsLoopbackUrl(url))
                {
                    await ConnectLocalInternalAsync();
                }
                else
                {
                    await NavigateRemoteAsync(url);
                    if (!connected) MessageBox.Show(this, "连不上 " + Program.HostPortOf(url) + "。\n\n" +
                        "检查：地址/端口对不对、对方是否已开服、防火墙是否放行、是否在同一网络。", "连接服务器",
                        MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }
            }
        }

        private async void OnConnectLocal(object sender, EventArgs e)
        {
            Program.WriteState(exeDir, "", string.Join(",", trustedHosts.ToArray()));   // 取消「默认连远端」
            await ConnectLocalInternalAsync();
        }

        private async Task ConnectLocalInternalAsync()
        {
            if (localServerPort != 0 && connected && !remoteTarget) { await LoadAsync(currentUrl, true); return; }
            await EnsureLocalServerAsync();
            UpdateChrome();
        }

        private void OnCopyLan(object sender, EventArgs e)
        {
            string t = CopyTarget();
            if (string.IsNullOrEmpty(t)) { MessageBox.Show(this, "没有可复制的地址。", "地址", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
            try { Clipboard.SetText(t); lblCopy.Text = "已复制 " + t; } catch { lblCopy.Text = "复制失败：" + t; }
        }

        private void OnOpenBrowser(object sender, EventArgs e)
        {
            try { if (currentUrl != null) Process.Start(currentUrl); } catch { }
        }

        private void OnRescanLan(object sender, EventArgs e)
        {
            localIp = Program.LocalIp();
            UpdateChrome();
        }

        private void OnRefresh(object sender, EventArgs e)
        {
            try { if (web.CoreWebView2 != null) web.CoreWebView2.Reload(); } catch { }
        }

        private void OnFullscreen(object sender, EventArgs e)
        {
            if (FormBorderStyle == FormBorderStyle.None)
            {
                FormBorderStyle = FormBorderStyle.Sizable;
                WindowState = FormWindowState.Normal;
            }
            else
            {
                FormBorderStyle = FormBorderStyle.None;
                WindowState = FormWindowState.Maximized;
            }
        }

        private void OnOpenGameDir(object sender, EventArgs e)
        {
            if (gameRoot == null) { MessageBox.Show(this, "当前没有绑定游戏目录（远端模式）。", "游戏目录", MessageBoxButtons.OK, MessageBoxIcon.Information); return; }
            try { Process.Start("explorer.exe", "\"" + gameRoot + "\""); } catch { }
        }

        private void OnOpenLog(object sender, EventArgs e)
        {
            try { if (File.Exists(logPath)) Process.Start("notepad.exe", "\"" + logPath + "\""); } catch { }
        }

        private void OnAbout(object sender, EventArgs e)
        {
            MessageBox.Show(this,
                "卫戍协议：盟约 · 桌面启动器\n\n" +
                "浏览器内核：系统 WebView2（Edge / Chromium）\n" +
                "Node 运行时：" + (nodeExe == null ? "（远端模式，未使用）" : nodeExe) + "\n" +
                "游戏本体：" + (gameRoot == null ? "（远端模式，未绑定）" : gameRoot) + "\n" +
                "当前连接：" + (currentUrl == null ? "未连接" : currentUrl) + "\n" +
                "代理：跟随系统设置\n" +
                "本机 IP：" + (localIp.Length > 0 ? localIp : "（未检测到）") + "\n\n" +
                "非官方同人作品，与上海鹰角网络科技有限公司（Hypergryph）、Yostar 及其关联方无关。\n" +
                "游戏素材版权归原权利人所有，仅供学习交流与个人非商业使用，严禁任何形式的盈利。\n" +
                "完整声明见游戏目录的 NOTICE.md。",
                "关于", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            try { healthTimer.Stop(); } catch { }
            if (weStartedServer && serverProc != null && !serverProc.HasExited)
            {
                AppendLog("[shell] killing node pid=" + serverProc.Id);
                try
                {
                    ProcessStartInfo psi = new ProcessStartInfo("taskkill", "/PID " + serverProc.Id + " /T /F");
                    psi.UseShellExecute = false; psi.CreateNoWindow = true;
                    Process k = Process.Start(psi);
                    if (k != null) k.WaitForExit(5000);
                }
                catch { try { serverProc.Kill(); } catch { } }
            }
            AppendLog("=== shell exit ===");
            try { if (log != null) log.Dispose(); } catch { }
            base.OnFormClosing(e);
        }

        // ---------------- 自检 ----------------

        private async Task RunSmokeAsync()
        {
            if (busy) return;
            busy = true;
            string js =
                "(function(){var b=document.getElementById('boot');var a=document.getElementById('app');" +
                "var s='unknown';try{localStorage.setItem('__poc','1');s=localStorage.getItem('__poc')==='1'?'ok':'readonly';}catch(e){s='blocked';}" +
                "return 'title='+document.title+';bootSplash='+(!!b)+';bootErr='+((document.getElementById('boot-err')||{}).textContent||'')+" +
                "';appChildren='+(a?a.children.length:-1)+';appBooted='+(!!window.__SP__)+" +
                "';importMaps='+!!(window.HTMLScriptElement&&HTMLScriptElement.supports&&HTMLScriptElement.supports('importmap'))+" +
                "';localStorage='+s+';webgl='+(function(){try{var c=document.createElement('canvas');return !!(c.getContext('webgl2')||c.getContext('webgl'));}catch(e){return false;}})();})()";

            // 页面文字：Chromium 自带的错误页会写出错误码，排障时有用
            string bodyText = null;
            try
            {
                bodyText = Unquote(await web.CoreWebView2.ExecuteScriptAsync(
                    "(function(){return String(document.body?document.body.innerText:'').replace(/[\\r\\n]+/g,' / ').slice(0,300);})()"));
                AppendLog("[smoke] bodyText = " + bodyText);
            }
            catch (Exception ex) { AppendLog("[smoke] bodyText failed: " + ex.Message); }

            string dom = null;
            for (int i = 0; i < 50; i++)
            {
                try
                {
                    string r = await web.CoreWebView2.ExecuteScriptAsync(js);
                    dom = Unquote(r);
                    if (dom != null && dom.IndexOf("appBooted=true", StringComparison.Ordinal) >= 0) break;
                }
                catch (Exception ex) { AppendLog("[smoke] exec failed: " + ex.Message); }
                await Task.Delay(500);
            }
            string health = "";
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(new Uri(new Uri(currentUrl), "/healthz").ToString());
                req.Timeout = 3000;
                using (WebResponse resp = await req.GetResponseAsync())
                using (StreamReader sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                    health = await sr.ReadToEndAsync();
            }
            catch (Exception ex) { health = "error: " + ex.Message; }

            string png = opt.SmokePng;
            if (string.IsNullOrEmpty(png)) png = Path.Combine(exeDir, "shell-window.png");
            bool pngOk = false;
            try
            {
                using (MemoryStream ms = new MemoryStream())
                {
                    await web.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, ms);
                    File.WriteAllBytes(png, ms.ToArray());
                    pngOk = true;
                }
            }
            catch (Exception ex) { AppendLog("[smoke] capture failed: " + ex.Message); }

            string chromePng = Path.ChangeExtension(png, null) + "-chrome.png";
            bool chromeOk = false;
            try
            {
                using (Bitmap bmp = new Bitmap(Width, Height))
                {
                    DrawToBitmap(bmp, new Rectangle(0, 0, Width, Height));
                    bmp.Save(chromePng, System.Drawing.Imaging.ImageFormat.Png);
                    chromeOk = true;
                }
            }
            catch (Exception ex) { AppendLog("[smoke] chrome capture failed: " + ex.Message); }

            bool pass = dom != null && dom.IndexOf("appBooted=true", StringComparison.Ordinal) >= 0
                        && health.IndexOf("\"ok\":true", StringComparison.OrdinalIgnoreCase) >= 0;
            StringBuilder sb = new StringBuilder();
            sb.Append("{\n  \"ok\": ").Append(pass ? "true" : "false");
            sb.Append(",\n  \"shell\": \"thin/webview2\"");
            sb.Append(",\n  \"mode\": ").Append(Json(remoteTarget ? "remote" : "local"));
            sb.Append(",\n  \"certErrors\": ").Append(certErrors);
            sb.Append(",\n  \"trustedHosts\": ").Append(Json(string.Join(",", trustedHosts.ToArray())));

            sb.Append(",\n  \"webview2Runtime\": ").Append(Json(WebView2Version()));
            sb.Append(",\n  \"serverUrl\": ").Append(Json(currentUrl));
            sb.Append(",\n  \"display\": ").Append(Json(display));
            sb.Append(",\n  \"localIp\": ").Append(Json(localIp));
            sb.Append(",\n  \"lanUrl\": ").Append(Json(localServerPort != 0 ? Program.LanUrl(localServerPort) : ""));
            sb.Append(",\n  \"localServerPort\": ").Append(localServerPort);
            sb.Append(",\n  \"weStartedServer\": ").Append(weStartedServer ? "true" : "false");
            sb.Append(",\n  \"connected\": ").Append(connected ? "true" : "false");
            sb.Append(",\n  \"gameRoot\": ").Append(Json(gameRoot));
            sb.Append(",\n  \"node\": ").Append(Json(nodeExe));
            sb.Append(",\n  \"windowTitle\": ").Append(Json(Text));
            sb.Append(",\n  \"ui\": { \"menu\": ").Append(Json(MenuTexts())).Append(", \"status\": ").Append(Json(StatusTexts())).Append(" }");
            sb.Append(",\n  \"bodyText\": ").Append(Json(bodyText));
            sb.Append(",\n  \"dom\": ").Append(Json(dom));
            sb.Append(",\n  \"health\": ").Append(Json(health));
            // 版本自检（软更新）：本机版本 / 服务器版本 / 结论 —— 自检报告里也要能看见
            sb.Append(",\n  \"update\": { \"source\": ").Append(Json(updateSource))
              .Append(", \"localVersion\": ").Append(Json(LocalVersion()))
              .Append(", \"latestVersion\": ").Append(Json(updateLatest))
              .Append(", \"state\": ").Append(Json(updateState))
              .Append(", \"driftFiles\": ").Append(Json(updateDrift))
              .Append(", \"artDrift\": ").Append(Json(updateArtDrift))
              .Append(", \"pubkey\": ").Append(Json(updatePubkey.Length > 0 ? "有" : "无"))
              .Append(" }");
            sb.Append(",\n  \"screenshot\": ").Append(pngOk ? Json(png) : "null");
            sb.Append(",\n  \"screenshotChrome\": ").Append(chromeOk ? Json(chromePng) : "null");
            sb.Append("\n}\n");
            WriteSmokeReport(sb.ToString());
            Application.Exit();
        }

        private string MenuTexts()
        {
            List<string> names = new List<string>();
            if (MainMenuStrip != null)
                foreach (ToolStripItem it in MainMenuStrip.Items)
                {
                    List<string> subs = new List<string>();
                    ToolStripMenuItem mi = it as ToolStripMenuItem;
                    if (mi != null)
                        foreach (ToolStripItem s in mi.DropDownItems) if (!(s is ToolStripSeparator)) subs.Add(s.Text);
                    names.Add(it.Text + " = [" + string.Join(" | ", subs.ToArray()) + "]");
                }
            return string.Join(" ; ", names.ToArray());
        }

        private string StatusTexts()
        {
            List<string> t = new List<string>();
            if (status != null)
                foreach (ToolStripItem it in status.Items) if (it.Text != null && it.Text.Trim().Length > 0) t.Add(it.Text.Trim());
            return string.Join(" ; ", t.ToArray());
        }

        private static string WebView2Version()
        {
            try { return CoreWebView2Environment.GetAvailableBrowserVersionString(); }
            catch { return null; }
        }

        private void WriteSmokeReport(string json)
        {
            string outPath = opt.SmokeOut;
            if (string.IsNullOrEmpty(outPath)) outPath = Path.Combine(exeDir, "shell-smoke.json");
            try { File.WriteAllText(outPath, json, new UTF8Encoding(false)); } catch { }
            AppendLog("[smoke] report -> " + outPath);
        }

        private static string WaitingPage(string text)
        {
            return "<!doctype html><html><head><meta charset=\"utf-8\"></head>" +
                   "<body style=\"margin:0;height:100vh;display:flex;align-items:center;justify-content:center;" +
                   "background:#0c0f0e;color:#7fe3c0;font:14px/1.8 system-ui,'Microsoft YaHei',sans-serif\">" +
                   "<div style=\"text-align:center\"><div style=\"font-size:20px;letter-spacing:2px\">STRONGHOLD PROTOCOL</div>" +
                   "<div style=\"margin-top:8px;color:#9ab\">" + text + "</div></div></body></html>";
        }

        private static string ErrorPage(string url, string reason)
        {
            string h = "<!doctype html><html><head><meta charset=\"utf-8\"></head>" +
                       "<body style=\"margin:0;height:100vh;display:flex;align-items:center;justify-content:center;" +
                       "background:#0c0f0e;color:#c3cbc7;font:14px/1.9 system-ui,'Microsoft YaHei',sans-serif\">" +
                       "<div style=\"text-align:center;max-width:620px;padding:24px\">" +
                       "<div style=\"font-size:20px;color:#7fe3c0;letter-spacing:2px\">STRONGHOLD PROTOCOL</div>" +
                       "<div style=\"margin-top:14px;font-size:16px\">连不上 " + url + "</div>" +
                       "<div style=\"color:#8fa39c;margin-top:6px\">" + reason + "</div>" +
                       "<div style=\"margin-top:16px\">检查对方是否已开服、地址端口是否正确。<br>" +
                       "本机若开了 Clash / v2ray 这类系统代理，本启动器已默认直连；<br>仍连不上可以用系统浏览器打开同一地址对比排查。<br>" +
                       "菜单「联机 → 连接服务器…」可以换个地址，或「连接本机服务器」自己开一局。</div></div></body></html>";
            return h;
        }

        /// <summary>ExecuteScriptAsync 返回的是 JSON 字符串（带引号、可能含 \\uXXXX），这里还原成原文。</summary>
        private static string Unquote(string s)
        {
            if (s == null) return null;
            s = s.Trim();
            if (s.Length < 2 || s[0] != '"') return s;
            s = s.Substring(1, s.Length - 2);
            StringBuilder sb = new StringBuilder(s.Length);
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (c != '\\' || i + 1 >= s.Length) { sb.Append(c); continue; }
                char n = s[++i];
                switch (n)
                {
                    case 'n': sb.Append('\n'); break;
                    case 'r': sb.Append('\r'); break;
                    case 't': sb.Append('\t'); break;
                    case 'b': sb.Append('\b'); break;
                    case 'f': sb.Append('\f'); break;
                    case 'u':
                        if (i + 4 < s.Length)
                        {
                            int code;
                            if (int.TryParse(s.Substring(i + 1, 4), System.Globalization.NumberStyles.HexNumber, null, out code))
                            { sb.Append((char)code); i += 4; }
                        }
                        break;
                    default: sb.Append(n); break;
                }
            }
            return sb.ToString();
        }

        private static string Json(string s)
        {
            if (s == null) return "null";
            StringBuilder sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 32) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.Append("\"").ToString();
        }
    }
}
