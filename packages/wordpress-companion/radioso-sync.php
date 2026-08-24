<?php
/**
 * Plugin Name: Radioso Sync
 * Description: Pushes published, updated, and deleted content of any post type
 *              — including WooCommerce products — to a Radioso workspace via
 *              signed webhook (HMAC-SHA256).
 * Version:     0.5.0
 * Requires at least: 5.7
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

const RADIOSO_OPT_WEBHOOK_URL     = 'radioso_sync_webhook_url';
const RADIOSO_OPT_SHARED_SECRET   = 'radioso_sync_shared_secret';
const RADIOSO_OPT_POST_TYPES      = 'radioso_sync_post_types';
const RADIOSO_OPT_AUTHOR_TAXONOMY = 'radioso_sync_author_taxonomy';
const RADIOSO_OPT_RESYNC_STATE    = 'radioso_sync_resync_state';
const RADIOSO_OPT_RESYNC_LOCK     = 'radioso_sync_resync_lock';
const RADIOSO_RESYNC_BATCH_SIZE   = 20;
const RADIOSO_RESYNC_LOG_LIMIT    = 20;
const RADIOSO_RESYNC_STALL_AFTER  = 300;
/**
 * WooCommerce syncs a variable product's price range from its variations on
 * `shutdown` at priority 10 (`WC_Post_Data::do_deferred_product_sync`), writing
 * `_price` directly. Flushing before that would publish the previous range and
 * strand anything the sync queues, so this has to run after it.
 */
const RADIOSO_FLUSH_PRIORITY      = 100;

// What the Radioso webhook accepts in a post's field map. Mirrored here so a
// site that adds its own fields learns the shape by losing one field, not by
// losing the whole push to a 400.
const RADIOSO_MAX_FIELDS          = 32;
const RADIOSO_MAX_FIELD_LENGTH    = 256;

// ── Event hooks ─────────────────────────────────────────────────────────────

add_action('transition_post_status', 'radioso_on_transition', 10, 3);
add_action('before_delete_post',     'radioso_on_delete',     10, 1);
add_action('woocommerce_product_set_stock_status', 'radioso_on_stock_status_change', 10, 3);
add_action('woocommerce_update_product',            'radioso_on_product_updated',      10, 1);
add_action('woocommerce_updated_product_price',     'radioso_on_product_price_updated', 10, 1);
add_action('woocommerce_update_product_variation',  'radioso_on_variation_updated',    10, 2);
add_action('shutdown', 'radioso_flush_queued_dispatches', RADIOSO_FLUSH_PRIORITY);
add_action('admin_post_radioso_resync_start', 'radioso_resync_start');
add_action('admin_post_radioso_resync_cancel', 'radioso_resync_cancel');
add_action('admin_post_radioso_resync_run_now', 'radioso_resync_run_now');
add_action('radioso_resync_batch', 'radioso_run_resync_batch');

function radioso_on_transition($new_status, $old_status, $post) {
    if (!radioso_should_sync($post)) {
        return;
    }

    if ($new_status === 'publish' && $old_status !== 'publish') {
        radioso_queue_dispatch('published', $post);
    } elseif ($new_status === 'publish' && $old_status === 'publish') {
        radioso_queue_dispatch('updated', $post);
    } elseif ($old_status === 'publish' && $new_status !== 'publish') {
        // Unpublish (draft, trash) is treated as a delete on the Radioso side.
        radioso_cancel_queued_dispatch($post->ID);
        radioso_dispatch('deleted', $post);
    }
}

function radioso_on_delete($post_id) {
    $post = get_post($post_id);
    if ($post && radioso_should_sync($post)) {
        // Deletes cannot wait for the flush: by then the post and its permalink
        // are gone.
        radioso_cancel_queued_dispatch($post_id);
        radioso_dispatch('deleted', $post);
    }
}

/**
 * Availability is the one published fact that changes without anyone editing the
 * post, so a status flip has to re-push on its own. WooCommerce fires this after
 * its data store has written the new status, so re-reading the product below
 * reflects it. Quantity changes that leave the status alone are deliberately not
 * hooked: they would re-embed the catalogue without changing anything we publish.
 */
function radioso_on_stock_status_change($product_id, $stock_status = '', $product = null) {
    radioso_queue_product(radioso_product_document_id($product_id, $product));
}

/**
 * Price and stock move without anyone touching the post: scheduled sales, CSV
 * imports, bulk edits and orders all persist through the product data store
 * without a post-status transition. This is the hook that sees a whole-product
 * save from any of those paths.
 */
function radioso_on_product_updated($product_id) {
    radioso_queue_product($product_id);
}

/**
 * A variable product's displayed price is a range derived from its variations,
 * and WooCommerce rewrites it by touching `_price` directly rather than saving
 * the product — so `woocommerce_update_product` never fires for it. This is the
 * action WooCommerce raises for exactly that case.
 */
function radioso_on_product_price_updated($product_id) {
    radioso_queue_product($product_id);
}

/**
 * Backstop for a variation saved on a path that skips the deferred parent sync.
 * Variations are their own posts and are never synced in their own right; the
 * parent product is what Radioso holds a document for.
 */
function radioso_on_variation_updated($variation_id, $variation = null) {
    radioso_queue_product(radioso_product_document_id($variation_id, $variation));
}

/**
 * Every core product hook this plugin listens to passes an ID. WooCommerce's own
 * webhook code still normalises a WC_Product at this point, because the quick and
 * bulk edit actions hand out objects and a site can map those onto a topic. The
 * guard is worth keeping: casting an object to int yields 1 in PHP, so an
 * unnormalised argument would quietly push whatever post 1 happens to be under
 * the product's identity rather than failing.
 */
function radioso_product_id_from($value) {
    if (is_object($value) && method_exists($value, 'get_id')) {
        return (int) $value->get_id();
    }

    return is_numeric($value) ? (int) $value : 0;
}

function radioso_product_document_id($product_id, $product = null) {
    if (is_object($product) && method_exists($product, 'get_parent_id') && $product->get_parent_id()) {
        return (int) $product->get_parent_id();
    }

    $post_id = radioso_product_id_from($product_id);
    if ($post_id <= 0) {
        return 0;
    }

    $parent_id = (int) wp_get_post_parent_id($post_id);
    return $parent_id > 0 ? $parent_id : $post_id;
}

function radioso_queue_product($product_or_id) {
    $post_id = radioso_product_id_from($product_or_id);
    if ($post_id <= 0) {
        return;
    }

    $post = get_post($post_id);
    if (!$post || $post->post_status !== 'publish' || !radioso_should_sync($post)) {
        return;
    }

    radioso_queue_dispatch('updated', $post);
}

/**
 * Publishes and updates are collected and sent once, at the end of the request.
 *
 * WordPress fires `transition_post_status` from inside `wp_insert_post()`, before
 * the `save_post` pass that plugins use to write their own meta — WooCommerce
 * writes price, stock and attributes there. Sending from the transition would
 * therefore publish the values as they stood before the edit. Deferring also
 * collapses the several hooks one save trips into a single push, so the document
 * is re-embedded once, carrying the state the request finished with.
 */
function radioso_queue_dispatch($event, $post) {
    if (!isset($GLOBALS['radioso_queued_dispatches'])) {
        $GLOBALS['radioso_queued_dispatches'] = [];
    }

    // Keyed by post: a publish followed by an update in one request is one push,
    // and the receiver ingests either event the same way.
    $GLOBALS['radioso_queued_dispatches'][(int) $post->ID] = $event;
}

function radioso_cancel_queued_dispatch($post_id) {
    unset($GLOBALS['radioso_queued_dispatches'][(int) $post_id]);
}

function radioso_flush_queued_dispatches() {
    if (empty($GLOBALS['radioso_queued_dispatches'])) {
        return;
    }

    $queued = $GLOBALS['radioso_queued_dispatches'];
    $GLOBALS['radioso_queued_dispatches'] = [];

    foreach ($queued as $post_id => $event) {
        // Re-read rather than trusting the object the hook handed us: it was
        // captured before the rest of the request wrote to it.
        $post = get_post($post_id);
        if (!$post || $post->post_status !== 'publish' || !radioso_should_sync($post)) {
            continue;
        }
        radioso_dispatch($event, $post);
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

function radioso_resync_safe_message($message) {
    $message = sanitize_text_field(wp_strip_all_tags((string) $message));
    $message = preg_replace(
        '/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=\-]+/i',
        '$1 [redacted]',
        $message
    );
    $message = preg_replace(
        '/\b(password|secret|token|api[_-]?key|authorization|x-radioso-signature|signature)\s*[=:]\s*\S+/i',
        '$1=[redacted]',
        $message
    );
    $message = preg_replace(
        '/([?&](?:password|secret|token|api[_-]?key|signature)=)[^&\s]+/i',
        '$1[redacted]',
        $message
    );
    return substr($message, 0, 300);
}

function radioso_resync_add_log($state, $level, $message, $timestamp = null) {
    if (!is_array($state)) {
        $state = [];
    }
    $activity_log = isset($state['activity_log']) && is_array($state['activity_log'])
        ? $state['activity_log']
        : [];
    $activity_log[] = [
        'time'    => $timestamp === null ? time() : (int) $timestamp,
        'level'   => in_array($level, ['info', 'warning', 'error'], true) ? $level : 'info',
        'message' => radioso_resync_safe_message($message),
    ];
    $state['activity_log'] = array_slice($activity_log, -RADIOSO_RESYNC_LOG_LIMIT);
    return $state;
}

function radioso_resync_save_state($state, $level = null, $message = '') {
    $state['last_activity_at'] = time();
    if ($level !== null && $message !== '') {
        $state = radioso_resync_add_log($state, $level, $message);
    }
    update_option(RADIOSO_OPT_RESYNC_STATE, $state, false);
    return $state;
}

function radioso_resync_error_text($error, $fallback) {
    if (is_wp_error($error)) {
        $code = sanitize_key($error->get_error_code());
        $message = radioso_resync_safe_message($error->get_error_message());
        return trim(sprintf('%s%s', $code ? $code . ': ' : '', $message));
    }
    return radioso_resync_safe_message($fallback);
}

function radioso_schedule_resync_batch($state, $message) {
    $next_run_at = time() + 5;
    $scheduled = wp_schedule_single_event($next_run_at, 'radioso_resync_batch', [], true);
    if (is_wp_error($scheduled) || $scheduled === false) {
        $existing_event = wp_next_scheduled('radioso_resync_batch');
        if ($existing_event !== false) {
            $scheduled = true;
            $next_run_at = (int) $existing_event;
            $message = 'A background batch was already scheduled.';
        }
    }
    if (is_wp_error($scheduled) || $scheduled === false) {
        $error = radioso_resync_error_text($scheduled, 'WordPress rejected the cron event.');
        $state['status'] = 'failed';
        $state['next_run_at'] = 0;
        $state['batch_started_at'] = 0;
        $state['last_error'] = $error;
        radioso_resync_save_state($state, 'error', 'Could not schedule the next batch: ' . $error);
        return false;
    }

    $state['next_run_at'] = $next_run_at;
    $state['batch_started_at'] = 0;
    $state['last_error'] = '';
    radioso_resync_save_state($state, 'info', $message);
    return true;
}

function radioso_resync_delete_lock_if_unchanged($lock) {
    global $wpdb;

    $deleted = $wpdb->delete(
        $wpdb->options,
        [
            'option_name' => RADIOSO_OPT_RESYNC_LOCK,
            'option_value' => maybe_serialize($lock),
        ],
        ['%s', '%s']
    );
    if ($deleted !== 1) {
        return false;
    }
    wp_cache_delete(RADIOSO_OPT_RESYNC_LOCK, 'options');
    return true;
}

function radioso_resync_acquire_lock() {
    $now = time();
    $token = uniqid('radioso_resync_', true);
    $lock = ['token' => $token, 'acquired_at' => $now];
    if (add_option(RADIOSO_OPT_RESYNC_LOCK, $lock, '', false)) {
        return $token;
    }

    $existing = get_option(RADIOSO_OPT_RESYNC_LOCK, []);
    $acquired_at = is_array($existing) && isset($existing['acquired_at'])
        ? (int) $existing['acquired_at']
        : 0;
    if ($acquired_at > 0 && ($now - $acquired_at) < RADIOSO_RESYNC_STALL_AFTER) {
        return false;
    }

    if (!radioso_resync_delete_lock_if_unchanged($existing)) {
        return false;
    }
    return add_option(RADIOSO_OPT_RESYNC_LOCK, $lock, '', false) ? $token : false;
}

function radioso_resync_release_lock($token) {
    if (!$token) {
        return;
    }
    $existing = get_option(RADIOSO_OPT_RESYNC_LOCK, []);
    if (is_array($existing) && isset($existing['token']) && $existing['token'] === $token) {
        radioso_resync_delete_lock_if_unchanged($existing);
    }
}

function radioso_resync_owns_lock($token) {
    if (!$token) {
        return false;
    }
    $existing = get_option(RADIOSO_OPT_RESYNC_LOCK, []);
    return is_array($existing) && isset($existing['token']) && $existing['token'] === $token;
}

function radioso_resync_lock_is_active() {
    $existing = get_option(RADIOSO_OPT_RESYNC_LOCK, []);
    $acquired_at = is_array($existing) && isset($existing['acquired_at'])
        ? (int) $existing['acquired_at']
        : 0;
    return $acquired_at > 0 && (time() - $acquired_at) < RADIOSO_RESYNC_STALL_AFTER;
}

function radioso_resync_finish_batch_request() {
    $GLOBALS['radioso_resync_batch_active'] = false;
    $token = isset($GLOBALS['radioso_resync_batch_lock_token'])
        ? $GLOBALS['radioso_resync_batch_lock_token']
        : false;
    radioso_resync_release_lock($token);
    $GLOBALS['radioso_resync_batch_lock_token'] = false;
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
    if (radioso_resync_lock_is_active()) {
        radioso_resync_redirect('batch_busy');
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
    $state = [
        'status'     => 'running',
        'total'      => $total,
        'processed'  => 0,
        'offset'     => 0,
        'post_types' => $post_types,
        'started_at' => time(),
        'run_id' => uniqid('radioso_run_', true),
        'dispatch_errors' => 0,
        'last_error' => '',
        'activity_log' => [],
    ];
    $state = radioso_resync_add_log(
        $state,
        'info',
        sprintf('Resync requested for %d published posts.', $total)
    );

    if (!radioso_schedule_resync_batch($state, 'First background batch scheduled.')) {
        radioso_resync_redirect('schedule_failed');
    }
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
    $state['next_run_at'] = 0;
    $state['batch_started_at'] = 0;
    radioso_resync_save_state($state, 'warning', 'Resync cancelled by an administrator.');
    wp_clear_scheduled_hook('radioso_resync_batch');

    radioso_resync_redirect('cancelled');
}

function radioso_resync_run_now() {
    if (!current_user_can('manage_options')) {
        wp_die('You are not allowed to run a content resync batch.');
    }

    check_admin_referer('radioso_resync_run_now');

    $state = get_option(RADIOSO_OPT_RESYNC_STATE, []);
    $status = is_array($state) && isset($state['status']) ? $state['status'] : 'idle';
    if (!in_array($status, ['running', 'failed'], true)) {
        radioso_resync_redirect('not_running');
    }

    if (!radioso_run_resync_batch(true)) {
        radioso_resync_redirect('batch_busy');
    }
    radioso_resync_redirect('batch_ran');
}

function radioso_resync_capture_fatal() {
    if (empty($GLOBALS['radioso_resync_batch_active'])) {
        return;
    }

    $error = error_get_last();
    $fatal_types = [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR, E_RECOVERABLE_ERROR];
    if (!$error || !in_array($error['type'], $fatal_types, true)) {
        return;
    }

    $lock_token = isset($GLOBALS['radioso_resync_batch_lock_token'])
        ? $GLOBALS['radioso_resync_batch_lock_token']
        : false;
    if (!radioso_resync_owns_lock($lock_token)) {
        radioso_resync_finish_batch_request();
        return;
    }

    $state = get_option(RADIOSO_OPT_RESYNC_STATE, []);
    if (!is_array($state) || !isset($state['status']) || $state['status'] !== 'running') {
        radioso_resync_finish_batch_request();
        return;
    }

    $message = radioso_resync_safe_message($error['message']);
    $state['status'] = 'failed';
    $state['next_run_at'] = 0;
    $state['batch_started_at'] = 0;
    $state['last_error'] = $message;
    radioso_resync_save_state(
        $state,
        'error',
        'The batch stopped with a PHP fatal error: ' . $message
    );
    radioso_resync_finish_batch_request();
}

function radioso_run_resync_batch($manual = false) {
    $state = get_option(RADIOSO_OPT_RESYNC_STATE, []);
    $allowed_statuses = $manual ? ['running', 'failed'] : ['running'];
    if (!is_array($state) || !isset($state['status']) || !in_array($state['status'], $allowed_statuses, true)) {
        return false;
    }

    $lock_token = radioso_resync_acquire_lock();
    if ($lock_token === false) {
        return false;
    }
    $GLOBALS['radioso_resync_batch_lock_token'] = $lock_token;

    $state = get_option(RADIOSO_OPT_RESYNC_STATE, []);
    if (!is_array($state) || !isset($state['status']) || !in_array($state['status'], $allowed_statuses, true)) {
        radioso_resync_finish_batch_request();
        return false;
    }
    if ($manual) {
        wp_clear_scheduled_hook('radioso_resync_batch');
        $state['status'] = 'running';
        $state['next_run_at'] = 0;
        $state['last_error'] = '';
        $state = radioso_resync_save_state(
            $state,
            'info',
            'An administrator requested one batch immediately.'
        );
    }

    $post_types = isset($state['post_types']) && is_array($state['post_types'])
        ? $state['post_types']
        : [];
    $offset = isset($state['offset']) ? max(0, (int) $state['offset']) : 0;
    $run_id = isset($state['run_id']) ? (string) $state['run_id'] : '';

    $GLOBALS['radioso_resync_batch_active'] = true;
    register_shutdown_function('radioso_resync_capture_fatal');
    $state['next_run_at'] = 0;
    $state['batch_started_at'] = time();
    $state = radioso_resync_save_state(
        $state,
        'info',
        sprintf('Batch started at item %d.', $offset + 1)
    );

    if (!$post_types) {
        $state['status'] = 'complete';
        $state['batch_started_at'] = 0;
        radioso_resync_save_state($state, 'info', 'Resync complete; no configured post types were found.');
        radioso_resync_finish_batch_request();
        return true;
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

    $batch_dispatch_errors = 0;
    $last_dispatch_error = '';
    foreach ($query->posts as $post_id) {
        if (!radioso_resync_owns_lock($lock_token)) {
            radioso_resync_finish_batch_request();
            return false;
        }
        $post = get_post($post_id);
        if ($post && $post->post_status === 'publish' && radioso_should_sync($post)) {
            $dispatch_result = radioso_dispatch('updated', $post);
            if (is_wp_error($dispatch_result)) {
                $batch_dispatch_errors++;
                $last_dispatch_error = radioso_resync_error_text(
                    $dispatch_result,
                    'WordPress could not start the webhook request.'
                );
            }
        }
    }

    $batch_count = count($query->posts);

    if (!radioso_resync_owns_lock($lock_token)) {
        radioso_resync_finish_batch_request();
        return false;
    }

    // A cancellation that happened while this batch was dispatching must not
    // allow this handler to schedule another batch.
    $current_state = get_option(RADIOSO_OPT_RESYNC_STATE, []);
    $current_run_id = is_array($current_state) && isset($current_state['run_id'])
        ? (string) $current_state['run_id']
        : '';
    if (
        !is_array($current_state) ||
        !isset($current_state['status']) ||
        $current_state['status'] !== 'running' ||
        ($run_id !== '' && $current_run_id !== $run_id)
    ) {
        radioso_resync_finish_batch_request();
        return true;
    }

    $state['offset'] = $offset + $batch_count;
    $state['processed'] = min(
        (int) $state['total'],
        (isset($state['processed']) ? (int) $state['processed'] : 0) + $batch_count
    );
    $state['batch_started_at'] = 0;
    $state['dispatch_errors'] =
        (isset($state['dispatch_errors']) ? (int) $state['dispatch_errors'] : 0) + $batch_dispatch_errors;
    if ($batch_dispatch_errors > 0) {
        $state['last_error'] = $last_dispatch_error;
        $state = radioso_resync_add_log(
            $state,
            'warning',
            sprintf(
                '%d of %d webhook requests could not be started. Last error: %s',
                $batch_dispatch_errors,
                $batch_count,
                $last_dispatch_error
            )
        );
    }
    $state = radioso_resync_add_log(
        $state,
        'info',
        sprintf(
            'Batch checkpoint saved: %d of %d posts inspected.',
            $state['processed'],
            $state['total']
        )
    );

    if ($batch_count === RADIOSO_RESYNC_BATCH_SIZE && $state['offset'] < (int) $state['total']) {
        radioso_schedule_resync_batch($state, 'Next background batch scheduled.');
        radioso_resync_finish_batch_request();
        return true;
    }

    $state['status'] = (int) $state['dispatch_errors'] > 0 ? 'complete_with_errors' : 'complete';
    $state['processed'] = (int) $state['total'];
    $completion_message = $state['status'] === 'complete'
        ? sprintf('Resync complete. %d posts were inspected for dispatch.', $state['total'])
        : sprintf(
            'Resync finished with %d dispatch errors. Check the warning entries below.',
            $state['dispatch_errors']
        );
    radioso_resync_save_state(
        $state,
        $state['status'] === 'complete' ? 'info' : 'warning',
        $completion_message
    );
    radioso_resync_finish_batch_request();
    return true;
}

// ── Dispatch ────────────────────────────────────────────────────────────────

function radioso_should_sync($post) {
    $allowed = array_map('trim', explode(',', get_option(RADIOSO_OPT_POST_TYPES, 'page,post')));
    return in_array($post->post_type, $allowed, true);
}

/**
 * Post types whose `post_author` really is the byline. Everywhere else that
 * column names the account that created the record — on a WooCommerce catalogue
 * that is a staff login, not the author of the work. Radioso surfaces author
 * metadata in search and answers, so publishing the staff login there would
 * attribute the whole catalogue to whoever uploaded it.
 */
function radioso_byline_post_types() {
    return apply_filters('radioso_sync_byline_post_types', ['post', 'page']);
}

function radioso_term_names($post, $taxonomy) {
    if (!taxonomy_exists($taxonomy)) {
        return [];
    }

    $terms = get_the_terms($post, $taxonomy);
    if (!$terms || is_wp_error($terms)) {
        return [];
    }

    $names = [];
    foreach ($terms as $term) {
        if (isset($term->name) && $term->name !== '') {
            $names[] = $term->name;
        }
    }
    return $names;
}

/**
 * Sites that keep the real author in a taxonomy (a book catalogue, a magazine
 * archive) point the Author taxonomy setting at it. Otherwise we fall back to
 * the WordPress account, but only for the types where it is the byline.
 */
function radioso_author_payload($post) {
    $taxonomy = trim((string) get_option(RADIOSO_OPT_AUTHOR_TAXONOMY, ''));
    if ($taxonomy !== '') {
        $names = radioso_term_names($post, $taxonomy);
        if ($names) {
            return ['name' => implode(', ', $names)];
        }
    }

    if (!in_array($post->post_type, radioso_byline_post_types(), true)) {
        return null;
    }

    return [
        'id'   => (int) $post->post_author,
        'name' => get_the_author_meta('display_name', $post->post_author),
    ];
}

function radioso_taxonomy_label($taxonomy) {
    if (isset($taxonomy->labels->singular_name) && $taxonomy->labels->singular_name !== '') {
        return $taxonomy->labels->singular_name;
    }
    return isset($taxonomy->label) && $taxonomy->label !== '' ? $taxonomy->label : $taxonomy->name;
}

function radioso_taxonomy_facts($post) {
    $facts = [];
    $taxonomies = get_object_taxonomies($post->post_type, 'objects');
    if (!is_array($taxonomies)) {
        return $facts;
    }

    foreach ($taxonomies as $taxonomy) {
        // Internal taxonomies (WooCommerce visibility flags, upsell bookkeeping)
        // are machine state, not something a reader would ever be told.
        if (empty($taxonomy->public)) {
            continue;
        }
        $names = radioso_term_names($post, $taxonomy->name);
        if (!$names) {
            continue;
        }
        $facts[] = [
            'label' => radioso_taxonomy_label($taxonomy),
            'value' => implode(', ', $names),
        ];
    }

    return $facts;
}

/**
 * `wc_price()` returns markup and renders the currency symbol as an HTML entity.
 * The facts block is escaped on the way out, so the entity has to be resolved
 * here or Radioso would receive it double-encoded.
 */
function radioso_plain_price($amount) {
    return trim(html_entity_decode(wp_strip_all_tags(wc_price($amount)), ENT_QUOTES, 'UTF-8'));
}

/**
 * The prices as the shop itself displays them, tax handling included. Variable
 * products span their variations, so they carry both ends: quoting one number
 * for a product that spans several would misstate the price in both directions.
 *
 * Returns `['min' => float, 'max' => float]`, or an empty array when the shop
 * has no price to state. `max` is only set when it differs from `min`.
 */
function radioso_product_prices($product) {
    if ($product->is_type('variable')) {
        $min = $product->get_variation_price('min', true);
        $max = $product->get_variation_price('max', true);
        if ($min === '' || $min === null) {
            return [];
        }
        return (float) $min === (float) $max
            ? ['min' => (float) $min]
            : ['min' => (float) $min, 'max' => (float) $max];
    }

    $price = wc_get_price_to_display($product);
    if ($price === '' || $price === null) {
        return [];
    }

    return ['min' => (float) $price];
}

function radioso_product_price_text($product) {
    $prices = radioso_product_prices($product);
    if (!$prices) {
        return '';
    }

    return isset($prices['max'])
        ? radioso_plain_price($prices['min']) . ' – ' . radioso_plain_price($prices['max'])
        : radioso_plain_price($prices['min']);
}

function radioso_product_facts($post) {
    if (!function_exists('wc_get_product')) {
        return [];
    }

    $product = wc_get_product($post->ID);
    if (!$product) {
        return [];
    }

    $facts = [];

    $sku = (string) $product->get_sku();
    if ($sku !== '') {
        $facts[] = ['label' => 'SKU', 'value' => $sku];
    }

    $price_text = radioso_product_price_text($product);
    if ($price_text !== '') {
        // WooCommerce's own translation of the label, so the price is labelled in
        // the shop's language alongside the site-supplied taxonomy and attribute
        // labels. Falls back to English if the text domain is not loaded.
        $facts[] = ['label' => __('Price', 'woocommerce'), 'value' => $price_text];
    }

    // WooCommerce localises this and leaves it empty for an ordinary in-stock
    // item, so we only ever push a stock claim the shop is actively making.
    $availability = $product->get_availability();
    $availability_text = isset($availability['availability']) ? trim((string) $availability['availability']) : '';
    if ($availability_text !== '') {
        $facts[] = ['label' => '', 'value' => $availability_text];
    }

    $attributes = $product->get_attributes();
    if (!is_array($attributes)) {
        return $facts;
    }

    foreach ($attributes as $attribute) {
        if (!is_object($attribute) || !method_exists($attribute, 'get_visible') || !$attribute->get_visible()) {
            continue;
        }
        $values = $attribute->is_taxonomy()
            ? wc_get_product_terms($product->get_id(), $attribute->get_name(), ['fields' => 'names'])
            : $attribute->get_options();
        if (!is_array($values) || !$values) {
            continue;
        }
        $facts[] = [
            'label' => wc_attribute_label($attribute->get_name(), $product),
            'value' => implode(', ', $values),
        ];
    }

    return $facts;
}

/**
 * The same shop facts as the facts block, in the form Radioso filters on rather
 * than the form it reads aloud: raw numbers and machine values under stable
 * keys, so an operator can write "price under 20" or "in stock only" as a
 * retrieval rule. The facts block still carries the human rendering — this map
 * is what makes the values comparable, not what makes them quotable.
 *
 * Keys are fixed WooCommerce vocabulary rather than derived from the site's own
 * attribute names: a rule addresses a key literally, so a key that shifts with
 * the shop's language would break the rule that referenced it. Site-specific
 * attributes stay in the facts block, where their names do no harm.
 *
 * Prices are the display prices, so they match what the facts block quotes and
 * what the shopper is charged.
 */
function radioso_product_fields($post) {
    if (!function_exists('wc_get_product')) {
        return [];
    }

    $product = wc_get_product($post->ID);
    if (!$product) {
        return [];
    }

    $fields = [];

    $sku = (string) $product->get_sku();
    if ($sku !== '') {
        $fields['sku'] = $sku;
    }

    $prices = radioso_product_prices($product);
    if ($prices) {
        $fields['price'] = $prices['min'];
        if (isset($prices['max'])) {
            $fields['price_max'] = $prices['max'];
        }
        // A bare number cannot be compared across shops, and Radioso surfaces
        // the value to operators writing rules against it.
        $fields['currency'] = get_woocommerce_currency();
    }

    // Variable products hold regular and sale prices on their variations, so
    // the parent has none to state; the range above already carries the span.
    if (!$product->is_type('variable')) {
        $regular = $product->get_regular_price();
        if ($regular !== '' && $regular !== null) {
            $fields['regular_price'] = (float) wc_get_price_to_display($product, ['price' => $regular]);
        }
        $sale = $product->get_sale_price();
        if ($sale !== '' && $sale !== null) {
            $fields['sale_price'] = (float) wc_get_price_to_display($product, ['price' => $sale]);
        }
    }

    // Always stated, never omitted: a rule for "not on sale" needs the false as
    // much as a rule for "on sale" needs the true.
    $fields['on_sale'] = (bool) $product->is_on_sale();

    $stock_status = (string) $product->get_stock_status();
    if ($stock_status !== '') {
        // The machine value, not the localized label the facts block carries:
        // a rule written against "outofstock" must survive a translation change.
        $fields['stock_status'] = $stock_status;
    }

    // A site knows facts WooCommerce does not — a lending period, a supplier
    // lead time. Radioso only requires that a key stays addressable by a rule
    // and a value stays comparable by one, so anything else is dropped here
    // rather than rejected at the webhook.
    return radioso_valid_fields(apply_filters('radioso_sync_product_fields', $fields, $product, $post));
}

/**
 * Radioso counts a string in UTF-16 code units, the way a JSON consumer does,
 * so a value is measured the same way here rather than in bytes.
 */
function radioso_field_value_length($value) {
    if (function_exists('mb_convert_encoding')) {
        $utf16 = mb_convert_encoding($value, 'UTF-16LE', 'UTF-8');
        if (is_string($utf16)) {
            return (int) (strlen($utf16) / 2);
        }
    }

    // Bytes are never fewer than code units, so a site without mbstring drops a
    // borderline value rather than sending one Radioso would turn away.
    return strlen($value);
}

/**
 * The shape Radioso accepts: a key a metadata rule can address, a value a rule
 * can compare, and a map small enough to travel. Everything outside it is
 * dropped here — a single overlong custom field must not cost the site the
 * whole product push.
 */
function radioso_valid_fields($fields) {
    if (!is_array($fields)) {
        return [];
    }

    $valid = [];
    foreach ($fields as $key => $value) {
        if (!is_string($key) || !preg_match('/^[A-Za-z][A-Za-z0-9_]{0,63}$/', $key)) {
            continue;
        }
        if (is_string($value) && radioso_field_value_length($value) > RADIOSO_MAX_FIELD_LENGTH) {
            continue;
        }
        // INF and NAN have no JSON representation, so one of them would fail the
        // encode for the whole payload.
        if (is_float($value) && !is_finite($value)) {
            continue;
        }
        if (is_string($value) || is_int($value) || is_float($value) || is_bool($value)) {
            $valid[$key] = $value;
        }
    }

    // The product's own values are added before the filter runs, so trimming
    // from the end keeps them and drops the surplus a site added.
    return count($valid) > RADIOSO_MAX_FIELDS
        ? array_slice($valid, 0, RADIOSO_MAX_FIELDS, true)
        : $valid;
}

/**
 * Facts a theme renders around the post body rather than inside it: taxonomy
 * terms and, on WooCommerce, SKU, availability and product attributes. Radioso
 * only ever receives the post body, so without this block a catalogue's
 * structured facts (author, ISBN, format, page count) never reach retrieval.
 *
 * Labels come from the site's own taxonomy and attribute registrations, so the
 * block is emitted in whatever language the site is authored in.
 *
 * Price and availability both move without a post edit, so they are only safe to
 * publish because `woocommerce_update_product` and
 * `woocommerce_product_set_stock_status` re-push the product when they change.
 */
function radioso_facts_html($post) {
    $facts = array_merge(radioso_taxonomy_facts($post), radioso_product_facts($post));
    if (!$facts) {
        return '';
    }

    $items = '';
    foreach ($facts as $fact) {
        $items .= $fact['label'] === ''
            ? sprintf('<li>%s</li>', esc_html($fact['value']))
            : sprintf('<li>%s: %s</li>', esc_html($fact['label']), esc_html($fact['value']));
    }

    return '<ul class="radioso-facts">' . $items . '</ul>';
}

function radioso_rendered_content($post) {
    return apply_filters('the_content', $post->post_content) . radioso_facts_html($post);
}

function radioso_dispatch($event, $post) {
    $url    = get_option(RADIOSO_OPT_WEBHOOK_URL);
    $secret = get_option(RADIOSO_OPT_SHARED_SECRET);
    if (!$url || !$secret) {
        return new WP_Error('radioso_not_configured', 'Webhook URL or shared secret is missing.');
    }

    $post_payload = [
        'id'               => (int) $post->ID,
        'type'             => $post->post_type,
        'status'           => $post->post_status,
        'slug'             => $post->post_name,
        'title'            => get_the_title($post),
        'content_raw'      => $post->post_content,
        'content_rendered' => radioso_rendered_content($post),
        'excerpt_rendered' => apply_filters('the_excerpt', $post->post_excerpt),
        'link'             => get_permalink($post),
        'modified_gmt'     => $post->post_modified_gmt,
        'date_gmt'         => $post->post_date_gmt,
    ];

    $author = radioso_author_payload($post);
    if ($author !== null) {
        $post_payload['author'] = $author;
    }

    $fields = radioso_product_fields($post);
    if ($fields) {
        $post_payload['fields'] = $fields;
    }

    $payload = wp_json_encode([
        'event'    => $event,
        'site_url' => home_url('/'),
        'post'     => $post_payload,
    ]);

    if ($payload === false) {
        return new WP_Error('radioso_json_encode_failed', 'WordPress could not encode the webhook payload.');
    }

    $signature = 'sha256=' . hash_hmac('sha256', $payload, $secret);

    $response = wp_remote_post($url, [
        'headers'  => [
            'Content-Type'        => 'application/json',
            'X-Radioso-Signature' => $signature,
            'X-Radioso-Event'     => $event,
        ],
        'body'     => $payload,
        'timeout'  => 5,
        'blocking' => false,
    ]);
    return is_wp_error($response) ? $response : true;
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
    register_setting('radioso_sync', RADIOSO_OPT_AUTHOR_TAXONOMY, [
        'type'              => 'string',
        'sanitize_callback' => 'sanitize_key',
        'default'           => '',
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
        <p>Push WordPress content changes to a Radioso workspace, for any post
           type including WooCommerce products. Copy the webhook URL and shared
           secret from the WordPress connector settings inside Radioso.</p>
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
                        <p class="description">Comma-separated list of post types to sync. Defaults to <code>page,post</code>. Add <code>product</code> to sync a WooCommerce catalogue.</p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="<?php echo esc_attr(RADIOSO_OPT_AUTHOR_TAXONOMY); ?>">Author taxonomy</label></th>
                    <td>
                        <input
                            name="<?php echo esc_attr(RADIOSO_OPT_AUTHOR_TAXONOMY); ?>"
                            id="<?php echo esc_attr(RADIOSO_OPT_AUTHOR_TAXONOMY); ?>"
                            type="text"
                            class="regular-text code"
                            value="<?php echo esc_attr(get_option(RADIOSO_OPT_AUTHOR_TAXONOMY, '')); ?>" />
                        <p class="description">Optional. Taxonomy holding the real author of the work, for catalogues that do not use the WordPress account as the byline. Leave blank to use the WordPress author on posts and pages only.</p>
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
        'schedule_failed' => 'WordPress could not schedule the background resync. See the status and activity log below.',
        'batch_ran'       => 'The requested batch finished. See the updated status below.',
        'batch_busy'      => 'Another resync batch is already running. Wait for its checkpoint before trying again.',
        'not_running'     => 'There is no paused or running resync batch to run.',
    ];
    if (isset($messages[$status])) {
        $notice_class = $status === 'schedule_failed' ? 'notice-error' : 'notice-info';
        printf(
            '<div class="notice %s is-dismissible"><p>%s</p></div>',
            esc_attr($notice_class),
            esc_html($messages[$status])
        );
    }
}

function radioso_resync_cron_health($state) {
    if (!is_array($state) || !isset($state['status']) || $state['status'] !== 'running') {
        return null;
    }

    $now = time();
    $traffic_cron_disabled = defined('DISABLE_WP_CRON') && DISABLE_WP_CRON;
    $batch_started_at = isset($state['batch_started_at']) ? (int) $state['batch_started_at'] : 0;
    if ($batch_started_at > 0) {
        if (($now - $batch_started_at) >= RADIOSO_RESYNC_STALL_AFTER) {
            return [
                'level' => 'error',
                'message' => 'The current batch has not saved a checkpoint for at least five minutes. It may have timed out or stopped with a PHP error.',
            ];
        }
        return [
            'level' => 'info',
            'message' => 'A batch is currently running. Refresh this page after it finishes.',
        ];
    }

    $next_run_at = wp_next_scheduled('radioso_resync_batch');
    if ($next_run_at === false) {
        return [
            'level' => 'error',
            'message' => $traffic_cron_disabled
                ? 'No background batch is scheduled, and traffic-triggered WP-Cron is disabled. Confirm that a server cron calls wp-cron.php, or use “Run next batch now”.'
                : 'No background batch is scheduled. WP-Cron may have rejected or lost the event; use “Run next batch now” to continue and diagnose it.',
        ];
    }
    if ($next_run_at < ($now - 60)) {
        return [
            'level' => 'warning',
            'message' => 'The next batch is overdue. WordPress is not spawning WP-Cron reliably; use “Run next batch now” or check Site Health.',
        ];
    }

    if ($traffic_cron_disabled) {
        return [
            'level' => 'warning',
            'message' => sprintf(
                'The next batch is scheduled for %s. Traffic-triggered WP-Cron is disabled, so a server cron must call wp-cron.php.',
                wp_date('Y-m-d H:i:s T', $next_run_at)
            ),
        ];
    }

    return [
        'level' => 'info',
        'message' => sprintf('The next batch is scheduled for %s.', wp_date('Y-m-d H:i:s T', $next_run_at)),
    ];
}

function radioso_render_run_now_form($label = 'Run next batch now') {
    ?>
    <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
        <input type="hidden" name="action" value="radioso_resync_run_now" />
        <?php wp_nonce_field('radioso_resync_run_now'); ?>
        <?php submit_button($label, 'secondary', 'submit', false); ?>
    </form>
    <?php
}

function radioso_render_activity_log($state) {
    $activity_log = isset($state['activity_log']) && is_array($state['activity_log'])
        ? array_reverse($state['activity_log'])
        : [];
    if (!$activity_log) {
        return;
    }
    ?>
    <h3>Activity log</h3>
    <p class="description">Shows the latest <?php echo esc_html((string) RADIOSO_RESYNC_LOG_LIMIT); ?> WordPress-side events. “Dispatch initiated” does not confirm that Radioso accepted or ingested the post.</p>
    <table class="widefat striped" style="max-width: 900px;">
        <thead>
            <tr>
                <th scope="col">Time</th>
                <th scope="col">Level</th>
                <th scope="col">Event</th>
            </tr>
        </thead>
        <tbody>
            <?php foreach ($activity_log as $entry) : ?>
                <tr>
                    <td><?php echo esc_html(wp_date('Y-m-d H:i:s T', isset($entry['time']) ? (int) $entry['time'] : 0)); ?></td>
                    <td><?php echo esc_html(ucfirst(isset($entry['level']) ? $entry['level'] : 'info')); ?></td>
                    <td><?php echo esc_html(isset($entry['message']) ? $entry['message'] : ''); ?></td>
                </tr>
            <?php endforeach; ?>
        </tbody>
    </table>
    <?php
}

function radioso_render_resync_section() {
    $state = get_option(RADIOSO_OPT_RESYNC_STATE, []);
    if (!is_array($state)) {
        $state = [];
    }
    $status = isset($state['status']) ? $state['status'] : 'idle';
    $total = isset($state['total']) ? (int) $state['total'] : 0;
    $processed = isset($state['processed']) ? (int) $state['processed'] : 0;
    $dispatch_errors = isset($state['dispatch_errors']) ? (int) $state['dispatch_errors'] : 0;
    $is_configured = (bool) get_option(RADIOSO_OPT_WEBHOOK_URL) && (bool) get_option(RADIOSO_OPT_SHARED_SECRET);
    $cron_health = radioso_resync_cron_health($state);
    ?>
    <hr />
    <h2>Resync all content</h2>
    <p>Push all existing published content of the configured post types to Radioso in the background, in batches. It is safe to run again.</p>
    <?php if ($status === 'running') : ?>
        <p><strong><?php echo esc_html(sprintf('Resync in progress: %d / %d posts', $processed, $total)); ?></strong> <a href="<?php echo esc_url(admin_url('options-general.php?page=radioso-sync')); ?>">Refresh</a></p>
        <?php if ($cron_health) : ?>
            <?php $health_class = $cron_health['level'] === 'error' ? 'notice-error' : ($cron_health['level'] === 'warning' ? 'notice-warning' : 'notice-info'); ?>
            <div class="notice <?php echo esc_attr($health_class); ?> inline"><p><?php echo esc_html($cron_health['message']); ?></p></div>
        <?php endif; ?>
        <?php if ($cron_health && $cron_health['level'] !== 'info') : ?>
            <?php radioso_render_run_now_form(); ?>
        <?php endif; ?>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
            <input type="hidden" name="action" value="radioso_resync_cancel" />
            <?php wp_nonce_field('radioso_resync_cancel'); ?>
            <?php submit_button('Cancel resync', 'secondary', 'submit', false); ?>
        </form>
    <?php else : ?>
        <?php if ($status === 'complete') : ?>
            <p><strong><?php echo esc_html(sprintf('Resync complete (%d posts).', $total)); ?></strong></p>
        <?php elseif ($status === 'complete_with_errors') : ?>
            <div class="notice notice-warning inline"><p><strong><?php echo esc_html(sprintf('Resync finished with %d dispatch errors.', $dispatch_errors)); ?></strong> WordPress could not start some webhook requests. See the activity log below.</p></div>
        <?php elseif ($status === 'cancelled') : ?>
            <p><strong>Resync cancelled.</strong></p>
        <?php elseif ($status === 'failed') : ?>
            <div class="notice notice-error inline"><p><strong>Resync failed.</strong> <?php echo esc_html(isset($state['last_error']) ? $state['last_error'] : 'See the activity log below.'); ?></p></div>
            <?php radioso_render_run_now_form('Retry next batch now'); ?>
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
    <?php radioso_render_activity_log($state); ?>
    <?php
}
