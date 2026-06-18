// GameForge Unity bridge — runs a tiny local HTTP server inside the Unity
// Editor so the GameForge desktop app (and Claude) can drive the editor.
//
// Endpoints:
//   GET  /ping         -> { ok, version, unityVersion, projectName, isPlaying, isCompiling }
//   POST /rpc          -> run one editor command on the main thread
//   GET  /logs?since=N -> incremental console entries
//   GET  /screenshot   -> PNG capture of the Game view (camera render)
//
// Unity's API is main-thread-only, so HTTP requests that touch it are marshalled
// onto EditorApplication.update via a job queue and the calling thread waits for
// the result.

#if UNITY_EDITOR
using System;
using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEngine;

namespace GameForge
{
    [InitializeOnLoad]
    public static class GameForgeBridge
    {
        public const string Version = "0.1.0";
        static HttpListener _listener;
        static Thread _thread;
        static volatile bool _running;
        static int _port;

        static readonly ConcurrentQueue<Job> _jobs = new ConcurrentQueue<Job>();

        class Job
        {
            public Func<Response> Fn;
            public Response Result;
            public readonly ManualResetEventSlim Done = new ManualResetEventSlim(false);
        }

        static GameForgeBridge()
        {
            _port = ResolvePort();
            EditorApplication.update += PumpMainThread;
            AssemblyReloadEvents.beforeAssemblyReload += Stop;
            EditorApplication.quitting += Stop;
            Start();
        }

        static int ResolvePort()
        {
            var env = Environment.GetEnvironmentVariable("GAMEFORGE_BRIDGE_PORT");
            return int.TryParse(env, out var p) && p > 0 ? p : 17890;
        }

        static void Start()
        {
            if (_running) return;
            try
            {
                _listener = new HttpListener();
                _listener.Prefixes.Add($"http://127.0.0.1:{_port}/");
                _listener.Prefixes.Add($"http://localhost:{_port}/");
                _listener.Start();
                _running = true;
                _thread = new Thread(Loop) { IsBackground = true, Name = "GameForgeBridge" };
                _thread.Start();
                Debug.Log($"[GameForge] Bridge listening on http://127.0.0.1:{_port}/");
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[GameForge] Could not start bridge on port {_port}: {e.Message}");
                _running = false;
            }
        }

        static void Stop()
        {
            _running = false;
            try { _listener?.Stop(); } catch { }
            try { _listener?.Close(); } catch { }
            _listener = null;
        }

        static void Loop()
        {
            while (_running)
            {
                HttpListenerContext ctx;
                try { ctx = _listener.GetContext(); }
                catch { break; } // listener stopped
                ThreadPool.QueueUserWorkItem(_ => Handle(ctx));
            }
        }

        // Drain queued main-thread jobs each editor tick.
        static void PumpMainThread()
        {
            while (_jobs.TryDequeue(out var job))
            {
                try { job.Result = job.Fn(); }
                catch (Exception e) { job.Result = Response.Error(e.Message); }
                job.Done.Set();
            }
        }

        static Response RunOnMain(Func<Response> fn, int timeoutMs = 55000)
        {
            var job = new Job { Fn = fn };
            _jobs.Enqueue(job);
            if (!job.Done.Wait(timeoutMs)) return Response.Error("Editor command timed out");
            return job.Result;
        }

        static void Handle(HttpListenerContext ctx)
        {
            Response resp;
            try
            {
                var path = ctx.Request.Url.AbsolutePath;
                if (path == "/ping")
                {
                    resp = RunOnMain(Ping, 5000);
                }
                else if (path == "/logs")
                {
                    long since = 0;
                    long.TryParse(ctx.Request.QueryString["since"], out since);
                    resp = GameForgeLog.Dump(since); // thread-safe, no main thread needed
                }
                else if (path == "/screenshot")
                {
                    resp = RunOnMain(GameForgeCommands.CaptureGameView, 20000);
                }
                else if (path == "/rpc" && ctx.Request.HttpMethod == "POST")
                {
                    string body;
                    using (var reader = new StreamReader(ctx.Request.InputStream, Encoding.UTF8))
                        body = reader.ReadToEnd();
                    resp = RunOnMain(() => GameForgeCommands.Dispatch(body));
                }
                else
                {
                    resp = Response.Error("Not found", 404);
                }
            }
            catch (Exception e)
            {
                resp = Response.Error(e.Message, 500);
            }

            try
            {
                ctx.Response.StatusCode = resp.Status;
                ctx.Response.ContentType = resp.ContentType;
                ctx.Response.AddHeader("Access-Control-Allow-Origin", "*");
                ctx.Response.ContentLength64 = resp.Body.Length;
                ctx.Response.OutputStream.Write(resp.Body, 0, resp.Body.Length);
            }
            catch { /* client went away */ }
            finally { try { ctx.Response.OutputStream.Close(); } catch { } }
        }

        static Response Ping()
        {
            var sb = new StringBuilder();
            sb.Append("{\"ok\":true");
            sb.Append(",\"version\":\"").Append(Version).Append("\"");
            sb.Append(",\"unityVersion\":\"").Append(Json.Esc(Application.unityVersion)).Append("\"");
            sb.Append(",\"projectName\":\"").Append(Json.Esc(Application.productName)).Append("\"");
            sb.Append(",\"isPlaying\":").Append(EditorApplication.isPlaying ? "true" : "false");
            sb.Append(",\"isCompiling\":").Append(EditorApplication.isCompiling ? "true" : "false");
            sb.Append("}");
            return Response.Json(sb.ToString());
        }
    }

    /// <summary>HTTP response payload (JSON text or raw bytes such as PNG).</summary>
    public class Response
    {
        public int Status = 200;
        public string ContentType = "application/json";
        public byte[] Body = Array.Empty<byte>();

        public static Response Json(string json)
            => new Response { ContentType = "application/json", Body = Encoding.UTF8.GetBytes(json) };

        public static Response Png(byte[] bytes)
            => new Response { ContentType = "image/png", Body = bytes ?? Array.Empty<byte>() };

        public static Response Error(string message, int status = 200)
            => new Response { Status = status, Body = Encoding.UTF8.GetBytes("{\"ok\":false,\"error\":\"" + Json.Esc(message) + "\"}") };
    }
}
#endif
