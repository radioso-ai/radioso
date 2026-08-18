<?php

define('ABSPATH', __DIR__);

$GLOBALS['wp_options'] = [];
$GLOBALS['scheduled_result'] = true;
$GLOBALS['next_scheduled'] = false;
$GLOBALS['query_posts'] = [];
$GLOBALS['wp_cache_deletes'] = [];

class WPDB_Stub {
    public $options = 'wp_options';
    public $before_delete = null;

    public function delete($table, $where, $format) {
        if (is_callable($this->before_delete)) {
            $callback = $this->before_delete;
            $this->before_delete = null;
            $callback();
        }
        $current = $GLOBALS['wp_options'][$where['option_name']] ?? null;
        if (maybe_serialize($current) !== $where['option_value']) {
            return 0;
        }
        unset($GLOBALS['wp_options'][$where['option_name']]);
        return 1;
    }
}

$GLOBALS['wpdb'] = new WPDB_Stub();

class WP_Error {
    private $code;
    private $message;
    public function __construct($code, $message) { $this->code = $code; $this->message = $message; }
    public function get_error_code() { return $this->code; }
    public function get_error_message() { return $this->message; }
}

class WP_Query {
    public $posts;
    public $found_posts;
    public function __construct($args) {
        $this->posts = $GLOBALS['query_posts'];
        $this->found_posts = count($this->posts);
    }
}

function add_action(...$args) {}
function sanitize_text_field($value) { return trim(strip_tags((string) $value)); }
function wp_strip_all_tags($value) { return strip_tags((string) $value); }
function sanitize_key($value) { return preg_replace('/[^a-z0-9_\-]/', '', strtolower((string) $value)); }
function is_wp_error($value) { return $value instanceof WP_Error; }
function get_option($key, $default = false) { return $GLOBALS['wp_options'][$key] ?? $default; }
function update_option($key, $value, $autoload = null) { $GLOBALS['wp_options'][$key] = $value; return true; }
function add_option($key, $value, $deprecated = '', $autoload = true) {
    if (array_key_exists($key, $GLOBALS['wp_options'])) { return false; }
    $GLOBALS['wp_options'][$key] = $value;
    return true;
}
function delete_option($key) { unset($GLOBALS['wp_options'][$key]); return true; }
function maybe_serialize($value) { return is_array($value) ? serialize($value) : $value; }
function wp_cache_delete($key, $group = '') { $GLOBALS['wp_cache_deletes'][] = [$key, $group]; return true; }
function wp_schedule_single_event($timestamp, $hook, $args = [], $wp_error = false) { return $GLOBALS['scheduled_result']; }
function wp_clear_scheduled_hook($hook) { $GLOBALS['next_scheduled'] = false; return 1; }
function wp_next_scheduled($hook) { return $GLOBALS['next_scheduled']; }
function wp_date($format, $timestamp) { return gmdate($format, $timestamp); }
function get_post($id) { return (object) [
    'ID' => $id, 'post_type' => 'post', 'post_status' => 'publish', 'post_name' => 'post-' . $id,
    'post_content' => 'content', 'post_excerpt' => '', 'post_modified_gmt' => '2026-01-01 00:00:00',
    'post_date_gmt' => '2026-01-01 00:00:00', 'post_author' => 1,
]; }
function wp_json_encode($value) { return json_encode($value); }
function home_url($path = '') { return 'https://example.com' . $path; }
function get_the_title($post) { return 'Title'; }
function apply_filters($hook, $value) { return $value; }
function get_permalink($post) { return 'https://example.com/' . $post->post_name; }
function get_the_author_meta($field, $id) { return 'Author'; }
function wp_remote_post($url, $args) { return ['response' => ['code' => 204]]; }

require __DIR__ . '/../radioso-sync.php';

function assert_true($condition, $message) {
    if (!$condition) {
        fwrite(STDERR, "FAIL: {$message}\n");
        exit(1);
    }
}

$state = [];
for ($i = 1; $i <= 25; $i++) {
    $state = radioso_resync_add_log($state, 'info', 'entry ' . $i, $i);
}
assert_true(count($state['activity_log']) === 20, 'activity log is bounded');
assert_true($state['activity_log'][0]['message'] === 'entry 6', 'activity log retains newest entries');

$redacted = radioso_resync_safe_message(
    'Authorization: Bearer abc123 X-Radioso-Signature=sha256=xyz https://example.test/?token=hidden'
);
assert_true(strpos($redacted, 'abc123') === false, 'bearer credential is redacted');
assert_true(strpos($redacted, 'sha256=xyz') === false, 'signature is redacted');
assert_true(strpos($redacted, 'hidden') === false, 'query secret is redacted');

$GLOBALS['scheduled_result'] = new WP_Error('schedule_blocked', 'A plugin rejected secret=hidden');
$scheduled = radioso_schedule_resync_batch(['status' => 'running', 'activity_log' => []], 'scheduled');
$failed_state = get_option(RADIOSO_OPT_RESYNC_STATE, []);
assert_true($scheduled === false, 'schedule failure is returned');
assert_true($failed_state['status'] === 'failed', 'schedule failure is persisted');
assert_true(strpos($failed_state['last_error'], 'hidden') === false, 'schedule error secrets are redacted');

$GLOBALS['next_scheduled'] = false;
$health = radioso_resync_cron_health(['status' => 'running', 'batch_started_at' => 0]);
assert_true($health['level'] === 'error', 'missing cron event is reported');
$GLOBALS['next_scheduled'] = time() + 30;
$health = radioso_resync_cron_health(['status' => 'running', 'batch_started_at' => 0]);
assert_true($health['level'] === 'info', 'future cron event is reported');

$first_lock = radioso_resync_acquire_lock();
$second_lock = radioso_resync_acquire_lock();
assert_true(is_string($first_lock), 'first batch acquires the lock');
assert_true($second_lock === false, 'concurrent batch is rejected');
radioso_resync_release_lock($first_lock);
assert_true(is_string(radioso_resync_acquire_lock()), 'released lock can be acquired again');
delete_option(RADIOSO_OPT_RESYNC_LOCK);

$stale_lock = radioso_resync_acquire_lock();
$GLOBALS['wp_options'][RADIOSO_OPT_RESYNC_LOCK]['acquired_at'] = time() - RADIOSO_RESYNC_STALL_AFTER - 1;
$replacement_lock = radioso_resync_acquire_lock();
assert_true(is_string($replacement_lock), 'stale lock can be replaced');
assert_true(!radioso_resync_owns_lock($stale_lock), 'stale request loses lock ownership');
assert_true(radioso_resync_owns_lock($replacement_lock), 'replacement request owns the lock');
radioso_resync_release_lock($stale_lock);
assert_true(radioso_resync_owns_lock($replacement_lock), 'stale request cannot release replacement lock');
radioso_resync_release_lock($replacement_lock);

$stale_lock = radioso_resync_acquire_lock();
$GLOBALS['wp_options'][RADIOSO_OPT_RESYNC_LOCK]['acquired_at'] = time() - RADIOSO_RESYNC_STALL_AFTER - 1;
$newer_lock = ['token' => 'newer-worker', 'acquired_at' => time()];
$GLOBALS['wpdb']->before_delete = function () use ($newer_lock) {
    $GLOBALS['wp_options'][RADIOSO_OPT_RESYNC_LOCK] = $newer_lock;
};
assert_true(radioso_resync_acquire_lock() === false, 'stale takeover does not delete a newer lock');
assert_true(radioso_resync_owns_lock('newer-worker'), 'newer lock survives stale takeover race');
radioso_resync_release_lock('newer-worker');

$GLOBALS['scheduled_result'] = true;
$GLOBALS['query_posts'] = [11, 12];
$GLOBALS['wp_options'][RADIOSO_OPT_WEBHOOK_URL] = 'https://api.example.test/webhook';
$GLOBALS['wp_options'][RADIOSO_OPT_SHARED_SECRET] = 'secret';
$GLOBALS['wp_options'][RADIOSO_OPT_POST_TYPES] = 'post';
$GLOBALS['wp_options'][RADIOSO_OPT_RESYNC_STATE] = [
    'status' => 'running', 'total' => 2, 'processed' => 0, 'offset' => 0,
    'post_types' => ['post'], 'run_id' => 'run-1', 'dispatch_errors' => 0, 'activity_log' => [],
];
radioso_run_resync_batch();
$completed_state = get_option(RADIOSO_OPT_RESYNC_STATE, []);
assert_true($completed_state['status'] === 'complete', 'batch reaches complete state');
assert_true($completed_state['processed'] === 2, 'batch checkpoints processed count');
assert_true(count($completed_state['activity_log']) === 3, 'batch records start, checkpoint, and completion');
assert_true(get_option(RADIOSO_OPT_RESYNC_LOCK, false) === false, 'batch releases its lock');

echo "PASS: WordPress companion status behavior\n";
