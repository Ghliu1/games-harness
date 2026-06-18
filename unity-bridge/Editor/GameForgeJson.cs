// Minimal JSON helpers for the bridge. Requests are parsed with Unity's
// JsonUtility into a flat RpcRequest; responses are built as small JSON strings
// so we avoid any external JSON dependency.

#if UNITY_EDITOR
using System;
using System.Text;
using UnityEngine;

namespace GameForge
{
    /// <summary>
    /// Flat request shape. JsonUtility ignores unknown fields and leaves absent
    /// ones at default, so every command just reads the fields it needs.
    /// </summary>
    [Serializable]
    public class RpcRequest
    {
        public string method;
        public string name;
        public string parent;
        public string target;
        public string component;
        public string property;
        public string value;
        public string type;
        public string primitive;
        public string path;
        public string scriptName;
        public string materialPath;
        public string shader;
        public string color;
        public float[] position;
        public float[] rotation;
        public float[] scale;

        public static RpcRequest Parse(string body)
        {
            if (string.IsNullOrEmpty(body)) return new RpcRequest();
            return JsonUtility.FromJson<RpcRequest>(body) ?? new RpcRequest();
        }
    }

    public static class Json
    {
        public static string Esc(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var sb = new StringBuilder(s.Length + 8);
            foreach (var c in s)
            {
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }

        /// <summary>{ "ok": true, "result": "<escaped string>" }</summary>
        public static Response OkString(string result)
            => Response.Json("{\"ok\":true,\"result\":\"" + Esc(result) + "\"}");

        /// <summary>{ "ok": true, "result": <raw json> }</summary>
        public static Response OkRaw(string resultJson)
            => Response.Json("{\"ok\":true,\"result\":" + resultJson + "}");
    }
}
#endif
