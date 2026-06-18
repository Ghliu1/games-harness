using UnityEngine;

/// <summary>
/// Simple rigidbody-based player movement: WASD/arrows to move, space to jump.
/// Attach to a GameObject that has a Rigidbody and a Collider. Tweak the public
/// fields in the Inspector (or via GameForge's set_property tool).
/// </summary>
[RequireComponent(typeof(Rigidbody))]
public class PlayerController : MonoBehaviour
{
    public float moveSpeed = 6f;
    public float jumpForce = 6f;
    public float groundCheckDistance = 1.1f;

    Rigidbody _rb;

    void Awake()
    {
        _rb = GetComponent<Rigidbody>();
        _rb.constraints = RigidbodyConstraints.FreezeRotation;
    }

    void FixedUpdate()
    {
        float h = Input.GetAxisRaw("Horizontal");
        float v = Input.GetAxisRaw("Vertical");
        Vector3 dir = new Vector3(h, 0f, v).normalized;

        Vector3 velocity = dir * moveSpeed;
        velocity.y = _rb.velocity.y;
        _rb.velocity = velocity;

        if (Input.GetKey(KeyCode.Space) && IsGrounded())
            _rb.velocity = new Vector3(_rb.velocity.x, jumpForce, _rb.velocity.z);
    }

    bool IsGrounded()
    {
        return Physics.Raycast(transform.position, Vector3.down, groundCheckDistance);
    }
}
