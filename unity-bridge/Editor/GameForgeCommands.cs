// GameForge editor commands. Each method runs on Unity's main thread (marshalled
// by GameForgeBridge) and returns a Response. These map 1:1 to the agent's
// Unity tools, expressed entirely through Unity's real editor API.

#if UNITY_EDITOR
using System;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace GameForge
{
    public static class GameForgeCommands
    {
        public static Response Dispatch(string body)
        {
            var req = RpcRequest.Parse(body);
            switch (req.method)
            {
                case "refresh": return Refresh();
                case "createScene": return CreateScene(req);
                case "openScene": return OpenScene(req);
                case "saveScene": return SaveScene();
                case "listHierarchy": return ListHierarchy();
                case "createGameObject": return CreateGameObject(req);
                case "setTransform": return SetTransform(req);
                case "addComponent": return AddComponent(req);
                case "attachScript": return AttachScript(req);
                case "setProperty": return SetProperty(req);
                case "deleteGameObject": return DeleteGameObject(req);
                case "createMaterial": return CreateMaterial(req);
                case "assignMaterial": return AssignMaterial(req);
                case "createPrefab": return CreatePrefab(req);
                case "instantiatePrefab": return InstantiatePrefab(req);
                case "enterPlayMode": EditorApplication.isPlaying = true; return Json.OkString("Entering play mode.");
                case "exitPlayMode": EditorApplication.isPlaying = false; return Json.OkString("Exiting play mode.");
                default: return Response.Error($"Unknown method: {req.method}");
            }
        }

        // ---- scenes ---------------------------------------------------------
        static Response Refresh()
        {
            AssetDatabase.Refresh();
            return Json.OkString("Assets refreshed. Unity will recompile changed scripts; check the console for errors.");
        }

        static Response CreateScene(RpcRequest r)
        {
            if (string.IsNullOrEmpty(r.name)) return Response.Error("Scene name required");
            var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
            Directory.CreateDirectory("Assets/Scenes");
            var path = $"Assets/Scenes/{r.name}.unity";
            EditorSceneManager.SaveScene(scene, path);
            return Json.OkString($"Created and opened scene {path} (with a Main Camera and Directional Light).");
        }

        static Response OpenScene(RpcRequest r)
        {
            if (string.IsNullOrEmpty(r.path)) return Response.Error("Scene path required");
            EditorSceneManager.OpenScene(r.path, OpenSceneMode.Single);
            return Json.OkString($"Opened {r.path}.");
        }

        static Response SaveScene()
        {
            EditorSceneManager.SaveScene(SceneManager.GetActiveScene());
            return Json.OkString("Saved active scene.");
        }

        static Response ListHierarchy()
        {
            var sb = new StringBuilder();
            var scene = SceneManager.GetActiveScene();
            sb.Append("Scene: ").Append(scene.name).Append('\n');
            foreach (var root in scene.GetRootGameObjects())
                AppendNode(sb, root.transform, 0);
            return Json.OkString(sb.ToString());
        }

        static void AppendNode(StringBuilder sb, Transform t, int depth)
        {
            sb.Append(new string(' ', depth * 2)).Append("- ").Append(t.name);
            var comps = t.GetComponents<Component>();
            if (comps.Length > 1)
            {
                sb.Append("  [");
                bool first = true;
                foreach (var c in comps)
                {
                    if (c is Transform) continue;
                    if (!first) sb.Append(", ");
                    first = false;
                    sb.Append(c == null ? "<missing>" : c.GetType().Name);
                }
                sb.Append(']');
            }
            sb.Append('\n');
            for (int i = 0; i < t.childCount; i++) AppendNode(sb, t.GetChild(i), depth + 1);
        }

        // ---- game objects ---------------------------------------------------
        static Response CreateGameObject(RpcRequest r)
        {
            if (string.IsNullOrEmpty(r.name)) return Response.Error("Name required");
            GameObject go;
            if (!string.IsNullOrEmpty(r.primitive) &&
                Enum.TryParse<PrimitiveType>(r.primitive, true, out var prim))
            {
                go = GameObject.CreatePrimitive(prim);
                go.name = r.name;
            }
            else
            {
                go = new GameObject(r.name);
            }

            if (!string.IsNullOrEmpty(r.parent))
            {
                var parent = Find(r.parent);
                if (parent == null) return Response.Error($"Parent not found: {r.parent}");
                go.transform.SetParent(parent.transform, false);
            }

            if (r.position != null) go.transform.localPosition = ToVec(r.position, Vector3.zero);
            if (r.rotation != null) go.transform.localEulerAngles = ToVec(r.rotation, Vector3.zero);
            if (r.scale != null) go.transform.localScale = ToVec(r.scale, Vector3.one);

            Undo.RegisterCreatedObjectUndo(go, "Create " + r.name);
            MarkDirty();
            return Json.OkString(PathOf(go));
        }

        static Response SetTransform(RpcRequest r)
        {
            var go = Find(r.target);
            if (go == null) return Response.Error($"Target not found: {r.target}");
            if (r.position != null) go.transform.localPosition = ToVec(r.position, go.transform.localPosition);
            if (r.rotation != null) go.transform.localEulerAngles = ToVec(r.rotation, go.transform.localEulerAngles);
            if (r.scale != null) go.transform.localScale = ToVec(r.scale, go.transform.localScale);
            MarkDirty();
            return Json.OkString($"Updated transform of {PathOf(go)}.");
        }

        static Response AddComponent(RpcRequest r)
        {
            var go = Find(r.target);
            if (go == null) return Response.Error($"Target not found: {r.target}");
            var type = FindType(r.type);
            if (type == null) return Response.Error($"Component type not found: {r.type}");
            go.AddComponent(type);
            MarkDirty();
            return Json.OkString($"Added {type.Name} to {PathOf(go)}.");
        }

        static Response AttachScript(RpcRequest r)
        {
            var go = Find(r.target);
            if (go == null) return Response.Error($"Target not found: {r.target}");
            var type = FindType(r.scriptName);
            if (type == null)
                return Response.Error($"Script class '{r.scriptName}' not found. Did it compile? (write_file + refresh_assets, then check get_console.)");
            if (!typeof(MonoBehaviour).IsAssignableFrom(type))
                return Response.Error($"{r.scriptName} is not a MonoBehaviour.");
            go.AddComponent(type);
            MarkDirty();
            return Json.OkString($"Attached {type.Name} to {PathOf(go)}.");
        }

        static Response SetProperty(RpcRequest r)
        {
            var go = Find(r.target);
            if (go == null) return Response.Error($"Target not found: {r.target}");
            var comp = go.GetComponent(r.component);
            if (comp == null) return Response.Error($"Component '{r.component}' not found on {PathOf(go)}.");

            var so = new SerializedObject(comp);
            var prop = so.FindProperty(r.property)
                       ?? so.FindProperty("m_" + char.ToUpper(r.property[0]) + r.property.Substring(1));
            if (prop == null) return Response.Error($"Property '{r.property}' not found on {r.component}.");

            try { ApplyValue(prop, r.value); }
            catch (Exception e) { return Response.Error($"Could not set {r.property}: {e.Message}"); }

            so.ApplyModifiedProperties();
            MarkDirty();
            return Json.OkString($"Set {r.component}.{r.property} = {r.value}.");
        }

        static void ApplyValue(SerializedProperty prop, string value)
        {
            switch (prop.propertyType)
            {
                case SerializedPropertyType.Integer: prop.intValue = (int)ParseFloat(value); break;
                case SerializedPropertyType.Boolean: prop.boolValue = value == "1" || value.ToLower() == "true"; break;
                case SerializedPropertyType.Float: prop.floatValue = ParseFloat(value); break;
                case SerializedPropertyType.String: prop.stringValue = value; break;
                case SerializedPropertyType.Enum: ApplyEnum(prop, value); break;
                case SerializedPropertyType.Color: prop.colorValue = ParseColor(value); break;
                case SerializedPropertyType.Vector2: prop.vector2Value = (Vector2)ParseVec(value); break;
                case SerializedPropertyType.Vector3: prop.vector3Value = ParseVec(value); break;
                default: throw new Exception($"unsupported property type {prop.propertyType}");
            }
        }

        static void ApplyEnum(SerializedProperty prop, string value)
        {
            if (int.TryParse(value, out var idx)) { prop.enumValueIndex = idx; return; }
            var names = prop.enumNames;
            for (int i = 0; i < names.Length; i++)
                if (string.Equals(names[i], value, StringComparison.OrdinalIgnoreCase)) { prop.enumValueIndex = i; return; }
            throw new Exception($"enum value '{value}' not found");
        }

        static Response DeleteGameObject(RpcRequest r)
        {
            var go = Find(r.target);
            if (go == null) return Response.Error($"Target not found: {r.target}");
            var path = PathOf(go);
            Undo.DestroyObjectImmediate(go);
            MarkDirty();
            return Json.OkString($"Deleted {path}.");
        }

        // ---- materials & prefabs -------------------------------------------
        static Response CreateMaterial(RpcRequest r)
        {
            if (string.IsNullOrEmpty(r.path)) return Response.Error("Material path required");
            var shader = !string.IsNullOrEmpty(r.shader) ? Shader.Find(r.shader) : null;
            shader = shader ?? Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard");
            if (shader == null) return Response.Error("No suitable shader found");

            var mat = new Material(shader);
            if (!string.IsNullOrEmpty(r.color))
            {
                var col = ParseColor(r.color);
                if (mat.HasProperty("_BaseColor")) mat.SetColor("_BaseColor", col);
                if (mat.HasProperty("_Color")) mat.SetColor("_Color", col);
            }
            Directory.CreateDirectory(Path.GetDirectoryName(r.path));
            AssetDatabase.CreateAsset(mat, r.path);
            AssetDatabase.SaveAssets();
            return Json.OkString($"Created material {r.path}.");
        }

        static Response AssignMaterial(RpcRequest r)
        {
            var go = Find(r.target);
            if (go == null) return Response.Error($"Target not found: {r.target}");
            var mat = AssetDatabase.LoadAssetAtPath<Material>(r.materialPath);
            if (mat == null) return Response.Error($"Material not found: {r.materialPath}");
            var renderer = go.GetComponent<Renderer>();
            if (renderer == null) return Response.Error($"{PathOf(go)} has no Renderer.");
            renderer.sharedMaterial = mat;
            MarkDirty();
            return Json.OkString($"Assigned {r.materialPath} to {PathOf(go)}.");
        }

        static Response CreatePrefab(RpcRequest r)
        {
            var go = Find(r.target);
            if (go == null) return Response.Error($"Target not found: {r.target}");
            Directory.CreateDirectory(Path.GetDirectoryName(r.path));
            PrefabUtility.SaveAsPrefabAssetAndConnect(go, r.path, InteractionMode.UserAction);
            return Json.OkString($"Saved prefab {r.path}.");
        }

        static Response InstantiatePrefab(RpcRequest r)
        {
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(r.path);
            if (prefab == null) return Response.Error($"Prefab not found: {r.path}");
            var inst = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            if (r.position != null) inst.transform.position = ToVec(r.position, Vector3.zero);
            Undo.RegisterCreatedObjectUndo(inst, "Instantiate " + prefab.name);
            MarkDirty();
            return Json.OkString($"Instantiated {prefab.name} -> {PathOf(inst)}.");
        }

        // ---- screenshot -----------------------------------------------------
        public static Response CaptureGameView()
        {
            var cam = Camera.main;
            if (cam == null)
            {
                var all = Camera.allCameras;
                if (all.Length > 0) cam = all[0];
            }
            if (cam == null) return Response.Png(Array.Empty<byte>());

            int w = cam.pixelWidth > 0 ? Mathf.Min(cam.pixelWidth, 1280) : 960;
            int h = cam.pixelHeight > 0 ? Mathf.Min(cam.pixelHeight, 720) : 540;

            var rt = new RenderTexture(w, h, 24);
            var prevTarget = cam.targetTexture;
            var prevActive = RenderTexture.active;
            try
            {
                cam.targetTexture = rt;
                cam.Render();
                RenderTexture.active = rt;
                var tex = new Texture2D(w, h, TextureFormat.RGB24, false);
                tex.ReadPixels(new Rect(0, 0, w, h), 0, 0);
                tex.Apply();
                var png = tex.EncodeToPNG();
                UnityEngine.Object.DestroyImmediate(tex);
                return Response.Png(png);
            }
            finally
            {
                cam.targetTexture = prevTarget;
                RenderTexture.active = prevActive;
                rt.Release();
                UnityEngine.Object.DestroyImmediate(rt);
            }
        }

        // ---- helpers --------------------------------------------------------
        static GameObject Find(string target)
        {
            if (string.IsNullOrEmpty(target)) return null;
            var scene = SceneManager.GetActiveScene();
            var parts = target.Split('/');
            foreach (var root in scene.GetRootGameObjects())
            {
                if (root.name != parts[0]) continue;
                var cur = root.transform;
                bool ok = true;
                for (int i = 1; i < parts.Length; i++)
                {
                    var next = cur.Find(parts[i]);
                    if (next == null) { ok = false; break; }
                    cur = next;
                }
                if (ok) return cur.gameObject;
            }
            return GameObject.Find(target);
        }

        static string PathOf(GameObject go)
        {
            var t = go.transform;
            var path = t.name;
            while (t.parent != null) { t = t.parent; path = t.name + "/" + path; }
            return path;
        }

        static Type FindType(string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            // Direct hits in common namespaces.
            var direct = Type.GetType(name)
                ?? Type.GetType("UnityEngine." + name + ", UnityEngine")
                ?? Type.GetType("UnityEngine." + name + ", UnityEngine.CoreModule");
            if (direct != null) return direct;

            // Search every loaded assembly by full name then simple name.
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                var t = asm.GetType(name, false);
                if (t != null) return t;
            }
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type[] types;
                try { types = asm.GetTypes(); }
                catch (ReflectionTypeLoadException e) { types = e.Types; }
                foreach (var t in types)
                    if (t != null && t.Name == name) return t;
            }
            return null;
        }

        static void MarkDirty() => EditorSceneManager.MarkSceneDirty(SceneManager.GetActiveScene());

        static float ParseFloat(string s)
            => float.Parse(s, NumberStyles.Float, CultureInfo.InvariantCulture);

        static Vector3 ToVec(float[] a, Vector3 fallback)
        {
            if (a == null) return fallback;
            return new Vector3(
                a.Length > 0 ? a[0] : fallback.x,
                a.Length > 1 ? a[1] : fallback.y,
                a.Length > 2 ? a[2] : fallback.z);
        }

        static Vector3 ParseVec(string s)
        {
            var p = s.Split(',');
            return new Vector3(
                p.Length > 0 ? ParseFloat(p[0]) : 0,
                p.Length > 1 ? ParseFloat(p[1]) : 0,
                p.Length > 2 ? ParseFloat(p[2]) : 0);
        }

        static Color ParseColor(string s)
        {
            var p = s.Split(',');
            return new Color(
                p.Length > 0 ? ParseFloat(p[0]) : 1,
                p.Length > 1 ? ParseFloat(p[1]) : 1,
                p.Length > 2 ? ParseFloat(p[2]) : 1,
                p.Length > 3 ? ParseFloat(p[3]) : 1);
        }
    }
}
#endif
