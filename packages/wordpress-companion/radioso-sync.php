<?php
/**
 * Plugin Name: Radioso Sync
 * Description: Pushes published, updated, and deleted posts/pages to a Radioso
 *              workspace via signed webhook (HMAC-SHA256).
 * Version:     0.1.0
 * Author:      Radioso
 * License:     MIT
 *
 * Pairs with the WordPress connector in the Radioso backend at
 * backend/src/modules/connectors/plugins/wordpress/.
 *
 * Configure under Settings → Radioso Sync. The webhook URL and shared secret
 * are shown on the connector settings page inside Radioso.
 */

if (!defined('ABSPATH')) {
    exit;
}

const RADIOSO_OPT_WEBHOOK_URL   = 'radioso_sync_webhook_url';
const RADIOSO_OPT_SHARED_SECRET = 'radioso_sync_shared_secret';
const RADIOSO_OPT_POST_TYPES    = 'radioso_sync_post_types';

// ── Event hooks ─────────────────────────────────────────────────────────────

add_action('transition_post_status', 'radioso_on_transition', 10, 3);
add_action('before_delete_post',     'radioso_on_delete',     10, 1);

function radioso_on_transition($new_status, $old_status, $post) {
    if (!radioso_should_sync($post)) {
        return;
    }

    if ($new_status === 'publish' && $old_status !== 'publish') {
        radioso_dispatch('published', $post);
    } elseif ($new_status === 'publish' && $old_status === 'publish') {
        radioso_dispatch('updated', $post);
    } elseif ($old_status === 'publish' && $new_status !== 'publish') {
        // Unpublish (draft, trash) is treated as a delete on the Radioso side.
        radioso_dispatch('deleted', $post);
    }
}

function radioso_on_delete($post_id) {
    $post = get_post($post_id);
    if ($post && radioso_should_sync($post)) {
        radioso_dispatch('deleted', $post);
    }
}

// ── Dispatch ────────────────────────────────────────────────────────────────

function radioso_should_sync($post) {
    $allowed = array_map('trim', explode(',', get_option(RADIOSO_OPT_POST_TYPES, 'page,post')));
    return in_array($post->post_type, $allowed, true);
}

function radioso_dispatch($event, $post) {
    $url    = get_option(RADIOSO_OPT_WEBHOOK_URL);
    $secret = get_option(RADIOSO_OPT_SHARED_SECRET);
    if (!$url || !$secret) {
        return;
    }

    $payload = wp_json_encode([
        'event' => $event,
        'post'  => [
            'id'               => (int) $post->ID,
            'type'             => $post->post_type,
            'status'           => $post->post_status,
            'slug'             => $post->post_name,
            'title'            => get_the_title($post),
            'content_raw'      => $post->post_content,
            'content_rendered' => apply_filters('the_content', $post->post_content),
            'excerpt_rendered' => apply_filters('the_excerpt', $post->post_excerpt),
            'link'             => get_permalink($post),
            'modified_gmt'     => $post->post_modified_gmt,
            'date_gmt'         => $post->post_date_gmt,
            'author'           => [
                'id'   => (int) $post->post_author,
                'name' => get_the_author_meta('display_name', $post->post_author),
            ],
        ],
    ]);

    $signature = 'sha256=' . hash_hmac('sha256', $payload, $secret);

    wp_remote_post($url, [
        'headers'  => [
            'Content-Type'        => 'application/json',
            'X-Radioso-Signature' => $signature,
            'X-Radioso-Event'     => $event,
        ],
        'body'     => $payload,
        'timeout'  => 5,
        'blocking' => false,
    ]);
}

// ── Settings page ───────────────────────────────────────────────────────────

add_action('admin_init', 'radioso_register_settings');
add_action('admin_menu', 'radioso_register_menu');

function radioso_register_settings() {
    register_setting('radioso_sync', RADIOSO_OPT_WEBHOOK_URL, [
        'type'              => 'string',
        'sanitize_callback' => 'esc_url_raw',
        'default'           => '',
    ]);
    register_setting('radioso_sync', RADIOSO_OPT_SHARED_SECRET, [
        'type'              => 'string',
        'sanitize_callback' => 'sanitize_text_field',
        'default'           => '',
    ]);
    register_setting('radioso_sync', RADIOSO_OPT_POST_TYPES, [
        'type'              => 'string',
        'sanitize_callback' => 'sanitize_text_field',
        'default'           => 'page,post',
    ]);
}

function radioso_register_menu() {
    add_options_page(
        'Radioso Sync',
        'Radioso Sync',
        'manage_options',
        'radioso-sync',
        'radioso_render_settings_page'
    );
}

function radioso_render_settings_page() {
    if (!current_user_can('manage_options')) {
        return;
    }
    ?>
    <div class="wrap">
        <h1>Radioso Sync</h1>
        <p>Push WordPress page and post changes to a Radioso workspace.
           Copy the webhook URL and shared secret from the WordPress connector
           settings inside Radioso.</p>
        <form method="post" action="options.php">
            <?php settings_fields('radioso_sync'); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><label for="<?php echo esc_attr(RADIOSO_OPT_WEBHOOK_URL); ?>">Webhook URL</label></th>
                    <td>
                        <input
                            name="<?php echo esc_attr(RADIOSO_OPT_WEBHOOK_URL); ?>"
                            id="<?php echo esc_attr(RADIOSO_OPT_WEBHOOK_URL); ?>"
                            type="url"
                            class="regular-text code"
                            value="<?php echo esc_attr(get_option(RADIOSO_OPT_WEBHOOK_URL, '')); ?>"
                            placeholder="https://your-radioso.example.com/api/connectors/wordpress/&lt;workspace&gt;/webhook"
                            required />
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="<?php echo esc_attr(RADIOSO_OPT_SHARED_SECRET); ?>">Shared secret</label></th>
                    <td>
                        <input
                            name="<?php echo esc_attr(RADIOSO_OPT_SHARED_SECRET); ?>"
                            id="<?php echo esc_attr(RADIOSO_OPT_SHARED_SECRET); ?>"
                            type="password"
                            class="regular-text code"
                            value="<?php echo esc_attr(get_option(RADIOSO_OPT_SHARED_SECRET, '')); ?>"
                            autocomplete="new-password"
                            required />
                        <p class="description">Used to sign every webhook payload (HMAC-SHA256). Must match the secret saved in Radioso.</p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="<?php echo esc_attr(RADIOSO_OPT_POST_TYPES); ?>">Post types</label></th>
                    <td>
                        <input
                            name="<?php echo esc_attr(RADIOSO_OPT_POST_TYPES); ?>"
                            id="<?php echo esc_attr(RADIOSO_OPT_POST_TYPES); ?>"
                            type="text"
                            class="regular-text code"
                            value="<?php echo esc_attr(get_option(RADIOSO_OPT_POST_TYPES, 'page,post')); ?>" />
                        <p class="description">Comma-separated list of post types to sync. Defaults to <code>page,post</code>.</p>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>
    </div>
    <?php
}
