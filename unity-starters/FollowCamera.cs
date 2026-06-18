using UnityEngine;

/// <summary>
/// Smoothly follows a target transform with a fixed offset. Attach to the Main
/// Camera and assign `target` (e.g. the player) via the Inspector or the
/// set_property tool.
/// </summary>
public class FollowCamera : MonoBehaviour
{
    public Transform target;
    public Vector3 offset = new Vector3(0f, 6f, -8f);
    public float smoothTime = 0.15f;

    Vector3 _velocity;

    void LateUpdate()
    {
        if (target == null) return;
        Vector3 desired = target.position + offset;
        transform.position = Vector3.SmoothDamp(transform.position, desired, ref _velocity, smoothTime);
        transform.LookAt(target);
    }
}
