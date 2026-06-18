// Captures Unity console output into a thread-safe ring buffer with monotonic
// ids so the harness can poll incrementally (GET /logs?since=N).

#if UNITY_EDITOR
using System.Collections.Generic;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace GameForge
{
    [InitializeOnLoad]
    public static class GameForgeLog
    {
        struct Entry { public long id; public string type; public string message; }

        const int Capacity = 500;
        static readonly object _lock = new object();
        static readonly Queue<Entry> _entries = new Queue<Entry>();
        static long _nextId = 1;

        static GameForgeLog()
        {
            Application.logMessageReceivedThreaded += OnLog;
        }

        static void OnLog(string message, string stackTrace, LogType type)
        {
            lock (_lock)
            {
                _entries.Enqueue(new Entry { id = _nextId++, type = MapType(type), message = message });
                while (_entries.Count > Capacity) _entries.Dequeue();
            }
        }

        static string MapType(LogType t)
        {
            switch (t)
            {
                case LogType.Error:
                case LogType.Exception:
                case LogType.Assert: return "Error";
                case LogType.Warning: return "Warning";
                default: return "Log";
            }
        }

        public static Response Dump(long since)
        {
            var sb = new StringBuilder();
            long next = since;
            sb.Append("{\"ok\":true,\"logs\":[");
            bool first = true;
            lock (_lock)
            {
                foreach (var e in _entries)
                {
                    if (e.id <= since) continue;
                    if (!first) sb.Append(",");
                    first = false;
                    sb.Append("{\"id\":").Append(e.id)
                      .Append(",\"type\":\"").Append(Json.Esc(e.type)).Append("\"")
                      .Append(",\"message\":\"").Append(Json.Esc(e.message)).Append("\"}");
                    if (e.id > next) next = e.id;
                }
            }
            sb.Append("],\"next\":").Append(next).Append("}");
            return Response.Json(sb.ToString());
        }
    }
}
#endif
