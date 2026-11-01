// Pulsar DJ launcher: serves the app folder on localhost and opens it in a
// Chrome/Edge app window (no tabs, own icon, own profile). The server stops
// when the window is gone (heartbeat from the page).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Threading;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("Pulsar DJ")]
[assembly: System.Reflection.AssemblyProduct("Pulsar DJ")]
[assembly: System.Reflection.AssemblyVersion("0.1.0.0")]

static class PulsarLauncher
{
    const int Port = 5180;
    static string root;
    static DateTime lastPing = DateTime.UtcNow;

    static readonly Dictionary<string, string> Types = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        { ".html", "text/html; charset=utf-8" }, { ".js", "text/javascript; charset=utf-8" },
        { ".mjs", "text/javascript; charset=utf-8" }, { ".css", "text/css; charset=utf-8" },
        { ".json", "application/json; charset=utf-8" }, { ".svg", "image/svg+xml" },
        { ".png", "image/png" }, { ".ico", "image/x-icon" }, { ".wav", "audio/wav" }, { ".mp3", "audio/mpeg" },
        { ".xml", "application/xml; charset=utf-8" },
    };

    [STAThread]
    static int Main()
    {
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        root = Path.GetFullPath(Path.Combine(baseDir, "app"));
        if (!File.Exists(Path.Combine(root, "index.html")))
        {
            MessageBox.Show("Der Ordner \"app\" wurde neben Pulsar DJ.exe nicht gefunden.\n\nDie EXE muss im Ordner pulsar-dj liegen.", "Pulsar DJ", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        string url = "http://localhost:" + Port + "/?app=1";
        HttpListener listener = new HttpListener();
        listener.Prefixes.Add("http://localhost:" + Port + "/");
        try
        {
            listener.Start();
        }
        catch (HttpListenerException)
        {
            // already running (another Pulsar window or the dev server): just open a window
            OpenWindow(url);
            return 0;
        }

        Thread server = new Thread(() => Serve(listener)) { IsBackground = true };
        server.Start();

        Process browser = OpenWindow(url);
        DateTime started = DateTime.UtcNow;
        // run until the page stops pinging (window closed) and the browser process is gone
        while (true)
        {
            Thread.Sleep(1000);
            bool browserAlive = browser != null && !browser.HasExited;
            double silent = (DateTime.UtcNow - lastPing).TotalSeconds;
            bool warmup = (DateTime.UtcNow - started).TotalSeconds < 45;
            if (!browserAlive && !warmup && silent > 8) break;
            if (browserAlive && silent > 600) break; // safety net
        }
        listener.Stop();
        return 0;
    }

    static Process OpenWindow(string url)
    {
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string profile = Path.Combine(local, "PulsarDJ", "Browser");
        Directory.CreateDirectory(profile);
        string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        string[] candidates =
        {
            Path.Combine(pf, @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(pf86, @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(local, @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(pf86, @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(pf, @"Microsoft\Edge\Application\msedge.exe"),
        };
        foreach (string exe in candidates)
        {
            if (!File.Exists(exe)) continue;
            string args = "--app=\"" + url + "\" --user-data-dir=\"" + profile + "\" --no-first-run --no-default-browser-check " +
                          "--window-size=1600,960 --autoplay-policy=no-user-gesture-required --disable-features=Translate";
            try { return Process.Start(new ProcessStartInfo(exe, args) { UseShellExecute = false }); }
            catch (Exception) { }
        }
        try { Process.Start(url); }
        catch (Exception) { }
        MessageBox.Show("Chrome oder Edge wurde nicht gefunden. Pulsar wurde im Standardbrowser geöffnet.\nFür MIDI bitte Chrome oder Edge verwenden.", "Pulsar DJ", MessageBoxButtons.OK, MessageBoxIcon.Information);
        return null;
    }

    // Hosts of freely licensed music sources reachable through /proxy (for APIs without CORS headers).
    static readonly string[] ProxyHosts = { "archive.org", "api.openverse.org", "jamendo.com", "ccmixter.org", "freesound.org", "upload.wikimedia.org" };

    static bool Allowed(Uri u)
    {
        if (u == null || u.Scheme != "https") return false;
        string h = u.Host.ToLowerInvariant();
        foreach (string a in ProxyHosts)
        {
            bool sub = a == "archive.org" || a == "jamendo.com" || a == "ccmixter.org" || a == "freesound.org";
            if (h == a || (sub && h.EndsWith("." + a))) return true;
        }
        return false;
    }

    static void Proxy(string target, string range, HttpListenerResponse res)
    {
        Uri u;
        if (!Uri.TryCreate(target ?? "", UriKind.Absolute, out u) || !Allowed(u)) { res.StatusCode = 403; return; }
        ServicePointManager.SecurityProtocol = (SecurityProtocolType)(3072 | 12288);
        for (int hop = 0; hop < 6; hop++)
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(u);
            req.AllowAutoRedirect = false;
            req.MaximumResponseHeadersLength = -1;
            req.UserAgent = "PulsarDJ/0.1 (+https://github.com/SacredBanana7/pulsar-dj)";
            req.Timeout = 20000;
            // Range must go through AddRange on HttpWebRequest ("bytes=a-b" or "bytes=a-")
            var m = System.Text.RegularExpressions.Regex.Match(range ?? "", @"bytes=(\d+)-(\d*)");
            if (m.Success)
            {
                if (m.Groups[2].Value.Length > 0) req.AddRange(long.Parse(m.Groups[1].Value), long.Parse(m.Groups[2].Value));
                else req.AddRange(long.Parse(m.Groups[1].Value));
            }
            HttpWebResponse up;
            try { up = (HttpWebResponse)req.GetResponse(); }
            catch (WebException e) { up = e.Response as HttpWebResponse; if (up == null) { res.StatusCode = 502; return; } }
            using (up)
            {
                int code = (int)up.StatusCode;
                if (code >= 300 && code < 400 && up.Headers["Location"] != null)
                {
                    u = new Uri(u, up.Headers["Location"]);
                    if (!Allowed(u)) { res.StatusCode = 403; return; }
                    continue;
                }
                res.StatusCode = code;
                res.AddHeader("Access-Control-Allow-Origin", "*");
                if (up.ContentType != null) res.ContentType = up.ContentType;
                if (up.Headers["Content-Range"] != null) res.AddHeader("Content-Range", up.Headers["Content-Range"]);
                if (up.ContentLength >= 0) res.ContentLength64 = up.ContentLength;
                using (Stream s = up.GetResponseStream()) s.CopyTo(res.OutputStream);
                return;
            }
        }
        res.StatusCode = 508;
    }

    static void Serve(HttpListener listener)
    {
        while (listener.IsListening)
        {
            HttpListenerContext ctx;
            try { ctx = listener.GetContext(); }
            catch (Exception) { return; }
            ThreadPool.QueueUserWorkItem(_ => Handle(ctx));
        }
    }

    static void Handle(HttpListenerContext ctx)
    {
        HttpListenerResponse res = ctx.Response;
        try
        {
            string path = Uri.UnescapeDataString(ctx.Request.Url.AbsolutePath).TrimStart('/');
            if (path == "__alive")
            {
                lastPing = DateTime.UtcNow;
                res.StatusCode = 204;
                return;
            }
            if (path == "proxy")
            {
                Proxy(ctx.Request.QueryString["url"], ctx.Request.Headers["Range"], res);
                return;
            }
            if (path == "") path = "index.html";
            string baseDir = root;
            if (path.StartsWith("test-tracks/", StringComparison.OrdinalIgnoreCase))
                baseDir = Path.GetFullPath(Path.Combine(root, ".."));
            string file = Path.GetFullPath(Path.Combine(baseDir, path.Replace('/', Path.DirectorySeparatorChar)));
            if (!file.StartsWith(baseDir, StringComparison.OrdinalIgnoreCase)) { res.StatusCode = 403; return; }
            if (Directory.Exists(file)) file = Path.Combine(file, "index.html");
            if (!File.Exists(file)) { res.StatusCode = 404; return; }
            string type;
            res.ContentType = Types.TryGetValue(Path.GetExtension(file), out type) ? type : "application/octet-stream";
            res.AddHeader("Cache-Control", "no-cache");
            byte[] body = File.ReadAllBytes(file);
            res.ContentLength64 = body.Length;
            res.OutputStream.Write(body, 0, body.Length);
        }
        catch (Exception)
        {
            try { res.StatusCode = 500; } catch (Exception) { }
        }
        finally
        {
            try { res.Close(); } catch (Exception) { }
        }
    }
}
