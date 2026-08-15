<?php
/**
 * Plugin Name: Radioso Sync
 * Description: Pushes published, updated, and deleted posts/pages to a Radioso
 *              workspace via signed webhook (HMAC-SHA256).
 * Version:     0.3.0
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
const RADIOSO_OPT_RESYNC_STATE  = 'radioso_sync_resync_state';
const RADIOSO_RESYNC_BATCH_SIZE = 20;

// ── Event hooks ─────────────────────────────────────────────────────────────

add_action('transition_post_status', 'radioso_on_transition', 10, 3);
add_action('before_delete_post',     'radioso_on_delete',     10, 1);
add_action('admin_post_radioso_resync_start', 'radioso_resync_start');
add_action('admin_post_radioso_resync_cancel', 'radioso_resync_cancel');
add_action('radioso_resync_batch', 'radioso_run_resync_batch');

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

// ── Background resync ──────────────────────────────────────────────────────

function radioso_resync_redirect($status) {
    wp_safe_redirect(add_query_arg(
        'radioso_resync_status',
        $status,
        admin_url('options-general.php?page=radioso-sync')
    ));
    exit;
}

function radioso_resync_post_types() {
    $post_types = array_map('trim', explode(',', get_option(RADIOSO_OPT_POST_TYPES, 'page,post')));
    return array_values(array_filter($post_types, 'strlen'));
}

function radioso_resync_start() {
    if (!current_user_can('manage_options')) {
        wp_die('You are not allowed to resync content.');
    }

    check_admin_referer('radioso_resync_start');

    if (!get_option(RADIOSO_OPT_WEBHOOK_URL) || !get_option(RADIOSO_OPT_SHARED_SECRET)) {
        radioso_resync_redirect('not_configured');
    }

    $state = get_option(RADIOSO_OPT_RESYNC_STATE, []);
    if (is_array($state) && isset($state['status']) && $state['status'] === 'running') {
        radioso_resync_redirect('already_running');
    }

    $post_types = radioso_resync_post_types();
    $total = 0;
    if ($post_types) {
        $query = new WP_Query([
            'post_type'      => $post_types,
            'post_status'    => 'publish',
            'posts_per_page' => 1,
            'fields'         => 'ids',
            'no_found_rows'  => false,
        ]);
        $total = (int) $query->found_posts;
    }

    wp_clear_scheduled_hook('radioso_resync_batch');
    update_option(RADIOSO_OPT_RESYNC_STATE, [
        'status'     => 'running',
        'total'      => $total,
        'processed'  => 0,
        'offset'     => 0,
        'post_types' => $post_types,
        'started_at' => time(),
    ], false);

    wp_schedule_single_event(time() + 5, 'radioso_resync_batch');
    radioso_resync_redirect('started');
}

function radioso_resync_cancel() {
    if (!current_user_can('manage_options')) {
        wp_die('You are not allowed to cancel a content resync.');
    }

    check_admin_referer('radioso_resync_cancel');

    $state = get_option(RADIOSO_OPT_RESYNC_STATE, []);
    if (!is_array($state)) {
        $state = [];
    }
    $state['status'] = 'cancelled';
    update_option(RADIOSO_OPT_RESYNC_STATE, $state, false);
    wp_clear_scheduled_hook('radioso_resync_batch');

    radioso_resync_redirect('cancelled');
}

function radioso_run_resync_batch() {
    $state = get_option(RADIOSO_OPT_RESYNC_STATE, []);
    if (!is_array($state) || !isset($state['status']) || $state['status'] !== 'running') {
        return;
    }

    $post_types = isset($state['post_types']) && is_array($state['post_types'])
        ? $state['post_types']
        : [];
    $offset = isset($state['offset']) ? max(0, (int) $state['offset']) : 0;

    if (!$post_types) {
        $state['status'] = 'complete';
        update_option(RADIOSO_OPT_RESYNC_STATE, $state, false);
        return;
    }

    $query = new WP_Query([
        'post_type'      => $post_types,
        'post_status'    => 'publish',
        'posts_per_page' => RADIOSO_RESYNC_BATCH_SIZE,
        'offset'         => $offset,
        'orderby'        => 'ID',
        'order'          => 'ASC',
        'fields'         => 'ids',
        'no_found_rows'  => true,
    ]);

    foreach ($query->posts as $post_id) {
        $post = get_post($post_id);
        if ($post && $post->post_status === 'publish' && radioso_should_sync($post)) {
            radioso_dispatch('updated', $post);
        }
    }

    $batch_count = count($query->posts);

    // A cancellation that happened while this batch was dispatching must not
    // allow this handler to schedule another batch.
    $current_state = get_option(RADIOSO_OPT_RESYNC_STATE, []);
    if (!is_array($current_state) || !isset($current_state['status']) || $current_state['status'] !== 'running') {
        return;
    }

    $state['offset'] = $offset + $batch_count;
    $state['processed'] = min(
        (int) $state['total'],
        (isset($state['processed']) ? (int) $state['processed'] : 0) + $batch_count
    );

    if ($batch_count === RADIOSO_RESYNC_BATCH_SIZE && $state['offset'] < (int) $state['total']) {
        update_option(RADIOSO_OPT_RESYNC_STATE, $state, false);
        wp_schedule_single_event(time() + 5, 'radioso_resync_batch');
        return;
    }

    $state['status'] = 'complete';
    $state['processed'] = (int) $state['total'];
    update_option(RADIOSO_OPT_RESYNC_STATE, $state, false);
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
        'event'    => $event,
        'site_url' => home_url('/'),
        'post'     => [
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
        <?php radioso_render_resync_notice(); ?>
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
        <?php radioso_render_resync_section(); ?>
    </div>
    <?php
}

function radioso_render_resync_notice() {
    if (!isset($_GET['radioso_resync_status'])) {
        return;
    }

    $status = sanitize_key(wp_unslash($_GET['radioso_resync_status']));
    $messages = [
        'started'         => 'Content resync started.',
        'already_running' => 'A content resync is already running.',
        'cancelled'       => 'Content resync cancelled.',
        'not_configured'  => 'Set the webhook URL and shared secret before starting a content resync.',
    ];
    if (isset($messages[$status])) {
        printf('<div class="notice notice-info is-dismissible"><p>%s</p></div>', esc_html($messages[$status]));
    }
}

function radioso_render_resync_section() {
    $state = get_option(RADIOSO_OPT_RESYNC_STATE, []);
    if (!is_array($state)) {
        $state = [];
    }
    $status = isset($state['status']) ? $state['status'] : 'idle';
    $total = isset($state['total']) ? (int) $state['total'] : 0;
    $processed = isset($state['processed']) ? (int) $state['processed'] : 0;
    $is_configured = (bool) get_option(RADIOSO_OPT_WEBHOOK_URL) && (bool) get_option(RADIOSO_OPT_SHARED_SECRET);
    ?>
    <hr />
    <h2>Resync all content</h2>
    <p>Push all existing published posts and pages of the configured types to Radioso in the background, in batches. It is safe to run again.</p>
    <?php if ($status === 'running') : ?>
        <p><strong><?php echo esc_html(sprintf('Resync in progress: %d / %d posts', $processed, $total)); ?></strong> <a href="<?php echo esc_url(admin_url('options-general.php?page=radioso-sync')); ?>">Refresh</a></p>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
            <input type="hidden" name="action" value="radioso_resync_cancel" />
            <?php wp_nonce_field('radioso_resync_cancel'); ?>
            <?php submit_button('Cancel resync', 'secondary', 'submit', false); ?>
        </form>
    <?php else : ?>
        <?php if ($status === 'complete') : ?>
            <p><strong><?php echo esc_html(sprintf('Resync complete (%d posts).', $total)); ?></strong></p>
        <?php elseif ($status === 'cancelled') : ?>
            <p><strong>Resync cancelled.</strong></p>
        <?php endif; ?>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
            <input type="hidden" name="action" value="radioso_resync_start" />
            <?php wp_nonce_field('radioso_resync_start'); ?>
            <?php submit_button('Resync all content', 'secondary', 'submit', false, $is_configured ? [] : ['disabled' => 'disabled']); ?>
        </form>
        <?php if (!$is_configured) : ?>
            <p class="description">Set the webhook URL and shared secret before starting a resync.</p>
        <?php endif; ?>
    <?php endif; ?>
    <?php
}
