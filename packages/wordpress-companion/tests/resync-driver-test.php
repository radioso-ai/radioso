<?php
// The settings page keeps a resync going when WP-Cron cannot fire. Drives the
// admin-ajax handler the page script calls: one batch per request, only when the
// background batch is overdue or missing, never while another batch holds the lock.

require __DIR__ . '/support/wordpress-stubs.php';

class Radioso_Test_Response extends Exception {
    public $result;
    public function __construct($result) {
        parent::__construct('response sent');
        $this->result = $result;
    }
}

$GLOBALS['can_manage_options'] = true;

function current_user_can($capability) {
    return $capability === 'manage_options' && $GLOBALS['can_manage_options'];
}
function wp_create_nonce($action) { return 'nonce-for-' . $action; }
// Mirrors check_ajax_referer(): a missing or wrong nonce ends the request with "-1" and a 403.
function check_ajax_referer($action, $query_arg = false, $stop = true) {
    if (!isset($_REQUEST[$query_arg]) || $_REQUEST[$query_arg] !== wp_create_nonce($action)) {
        throw new Radioso_Test_Response(['success' => false, 'status' => 403, 'data' => '-1']);
    }
    return 1;
}
function wp_send_json_success($data = null, $status_code = null) {
    throw new Radioso_Test_Response(['success' => true, 'status' => $status_code ?? 200, 'data' => $data]);
}
function wp_send_json_error($data = null, $status_code = null) {
    throw new Radioso_Test_Response(['success' => false, 'status' => $status_code ?? 200, 'data' => $data]);
}
function admin_url($path = '') { return 'https://example.com/wp-admin/' . $path; }
function wp_nonce_field($action) { echo '<input type="hidden" name="_wpnonce" value="' . wp_create_nonce($action) . '" />'; }
function submit_button($text = '', $type = 'primary', $name = 'submit', $wrap = true, $other = []) {
    echo '<button type="submit" name="' . $name . '">' . $text . '</button>';
}
function esc_attr($value) { return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8'); }
function esc_url($value) { return (string) $value; }
function wp_print_inline_script_tag($javascript, $attributes = []) {
    echo '<script>' . $javascript . '</script>';
}

require __DIR__ . '/../radioso-sync.php';

// Starts a 45-post resync with the first batch of 20 ready to run, the cron event
// absent, and no lock held. Each case adjusts what it needs from there.
function seed_running_resync($overrides = []) {
    $GLOBALS['wp_options'] = [
        RADIOSO_OPT_WEBHOOK_URL   => 'https://api.example.test/webhook',
        RADIOSO_OPT_SHARED_SECRET => 'secret',
        RADIOSO_OPT_POST_TYPES    => 'post',
        RADIOSO_OPT_RESYNC_STATE  => array_merge([
            'status' => 'running', 'total' => 45, 'processed' => 0, 'offset' => 0,
            'post_types' => ['post'], 'run_id' => 'run-1', 'dispatch_errors' => 0,
            'last_error' => '', 'batch_started_at' => 0, 'next_run_at' => 0, 'activity_log' => [],
        ], $overrides),
    ];
    $GLOBALS['query_posts'] = range(1, RADIOSO_RESYNC_BATCH_SIZE);
    $GLOBALS['webhook_bodies'] = [];
    $GLOBALS['wp_cache'] = null;
    $GLOBALS['wp_cron_db'] = [];
    $GLOBALS['wp_cron_cache'] = null;
    $GLOBALS['scheduled_result'] = true;
    $GLOBALS['on_webhook'] = null;
    $GLOBALS['can_manage_options'] = true;
}

// Replaces the stored batch event: false for none, otherwise one at that time.
function set_cron_event($timestamp) {
    $GLOBALS['wp_cron_db'] = [];
    $GLOBALS['wp_cron_cache'] = null;
    if ($timestamp !== false) {
        wp_cron_store_event($timestamp);
    }
}

// What the next request would find scheduled.
function stored_cron_event() {
    wp_begin_request();
    return wp_next_scheduled('radioso_resync_batch');
}

// Each call is a request of its own, with a cold object cache, unless $new_request is false.
function drive_resync($request = ['nonce' => 'nonce-for-radioso_resync_drive'], $new_request = true) {
    $_POST = $request;
    $_REQUEST = $request;
    if ($new_request) {
        wp_begin_request();
    }
    try {
        radioso_resync_drive_ajax();
    } catch (Radioso_Test_Response $response) {
        return $response->result;
    }
    fwrite(STDERR, "FAIL: the handler returned without sending a response\n");
    exit(1);
}

// The stored state, whatever any request's cache holds.
function resync_state() {
    return $GLOBALS['wp_options'][RADIOSO_OPT_RESYNC_STATE] ?? [];
}

function log_messages() {
    return array_column(resync_state()['activity_log'] ?? [], 'message');
}

// ── Registration ────────────────────────────────────────────────────────────

assert_true(
    in_array('radioso_resync_drive_ajax', $GLOBALS['wp_actions']['wp_ajax_radioso_resync_drive'] ?? [], true),
    'the handler is registered for signed-in admin-ajax requests'
);
assert_true(
    !isset($GLOBALS['wp_actions']['wp_ajax_nopriv_radioso_resync_drive']),
    'signed-out visitors get no handler'
);

// ── Access ──────────────────────────────────────────────────────────────────

seed_running_resync();
set_cron_event(time() - 600);
$rejected = drive_resync([]);
assert_true($rejected['success'] === false && $rejected['status'] === 403, 'a request without a nonce is rejected');
assert_true(count($GLOBALS['webhook_bodies']) === 0, 'a request without a nonce dispatches nothing');
assert_true(resync_state()['offset'] === 0, 'a request without a nonce leaves the resync where it was');

$rejected = drive_resync(['nonce' => 'forged']);
assert_true($rejected['success'] === false && $rejected['status'] === 403, 'a forged nonce is rejected');
assert_true(count($GLOBALS['webhook_bodies']) === 0, 'a forged nonce dispatches nothing');

$GLOBALS['can_manage_options'] = false;
$rejected = drive_resync();
assert_true($rejected['success'] === false && $rejected['status'] === 403, 'a user without manage_options is rejected');
assert_true(count($GLOBALS['webhook_bodies']) === 0, 'a user without manage_options dispatches nothing');
assert_true(resync_state()['offset'] === 0, 'a user without manage_options leaves the resync where it was');

// ── Overdue: the page runs exactly one batch ────────────────────────────────

seed_running_resync();
set_cron_event(time() - 600);
$ran = drive_resync();
assert_true($ran['success'] === true, 'an overdue batch is run for an administrator');
assert_true($ran['data']['outcome'] === 'ran', 'the response says a batch ran');
assert_true(
    count($GLOBALS['webhook_bodies']) === RADIOSO_RESYNC_BATCH_SIZE,
    'exactly one batch of posts is dispatched'
);
assert_true($ran['data']['status'] === 'running', 'the resync is still running after one batch of three');
assert_true($ran['data']['offset'] === 20 && $ran['data']['processed'] === 20, 'the response reports the checkpoint');
assert_true($ran['data']['total'] === 45, 'the response reports the total');
assert_true($ran['data']['progress'] === 'Resync in progress: 20 / 45 posts', 'the response carries the progress text');
assert_true(is_int($ran['data']['retry_after']) && $ran['data']['retry_after'] >= 1, 'the response says when to come back');
assert_true(is_array($ran['data']['health']) && isset($ran['data']['health']['level'], $ran['data']['health']['message']), 'the response carries cron health');
assert_true(!array_key_exists(RADIOSO_OPT_RESYNC_LOCK, $GLOBALS['wp_options']), 'the batch releases its lock');

// ── Missing: no event at all ────────────────────────────────────────────────

seed_running_resync();
$ran = drive_resync();
assert_true($ran['data']['outcome'] === 'ran', 'a missing batch is run');
assert_true(count($GLOBALS['webhook_bodies']) === RADIOSO_RESYNC_BATCH_SIZE, 'a missing batch dispatches one batch');
assert_true(resync_state()['offset'] === 20, 'a missing batch advances the offset');

// ── Healthy cron: the page leaves the batch to WP-Cron ──────────────────────

seed_running_resync();
set_cron_event(time() + 30);
$waiting = drive_resync();
assert_true($waiting['success'] === true, 'a scheduled batch is not an error');
assert_true($waiting['data']['outcome'] === 'waiting', 'a batch scheduled in the future is left to WP-Cron');
assert_true(count($GLOBALS['webhook_bodies']) === 0, 'a batch scheduled in the future is not run by the page');
assert_true(resync_state()['offset'] === 0, 'a batch scheduled in the future leaves the offset alone');
assert_true($waiting['data']['health']['level'] === 'info', 'a healthy schedule reports info');

// A batch that is late by seconds is still within cron's normal jitter.
set_cron_event(time() - 20);
$waiting = drive_resync();
assert_true($waiting['data']['outcome'] === 'waiting', 'a batch a few seconds late is not yet overdue');
assert_true(count($GLOBALS['webhook_bodies']) === 0, 'a batch a few seconds late is not run by the page');

// ── Takeover: once the page has stepped in, it does not wait a minute per batch ──

seed_running_resync();
set_cron_event(time() + 4);
$waiting = drive_resync(['nonce' => 'nonce-for-radioso_resync_drive', 'takeover' => '1']);
assert_true($waiting['data']['outcome'] === 'waiting', 'a taking-over page still waits for the scheduled time');
assert_true(count($GLOBALS['webhook_bodies']) === 0, 'a taking-over page does not run a batch before it is due');
assert_true(
    $waiting['data']['retry_after'] >= 1 && $waiting['data']['retry_after'] <= 5,
    'a taking-over page is told to come back when the batch is due'
);

set_cron_event(time() - 5);
$ran = drive_resync(['nonce' => 'nonce-for-radioso_resync_drive', 'takeover' => '1']);
assert_true($ran['data']['outcome'] === 'ran', 'a taking-over page runs a batch as soon as it is due');
assert_true(count($GLOBALS['webhook_bodies']) === RADIOSO_RESYNC_BATCH_SIZE, 'a taking-over page runs one batch');

// ── Another batch holds the lock: back off ──────────────────────────────────

seed_running_resync();
set_cron_event(time() - 600);
$GLOBALS['wp_options'][RADIOSO_OPT_RESYNC_LOCK] = ['token' => 'other-run', 'acquired_at' => time()];
$busy = drive_resync();
assert_true($busy['success'] === true, 'a held lock is not an error');
assert_true($busy['data']['outcome'] === 'busy', 'a held lock is reported as busy');
assert_true(count($GLOBALS['webhook_bodies']) === 0, 'nothing is dispatched while another batch holds the lock');
assert_true(resync_state()['offset'] === 0, 'a busy response leaves the offset alone');
assert_true($busy['data']['retry_after'] >= 1, 'a busy response says when to poll again');
assert_true(
    $GLOBALS['wp_options'][RADIOSO_OPT_RESYNC_LOCK]['token'] === 'other-run',
    'the page does not take the lock from the batch that holds it'
);

// Another request can take the lock after this one has decided to run and before it inserts the
// lock. The insert is one statement, so that request's lock stands.
seed_running_resync();
set_cron_event(time() - 600);
$GLOBALS['wpdb']->before_query = function () {
    $GLOBALS['wp_options'][RADIOSO_OPT_RESYNC_LOCK] = ['token' => 'other-run', 'acquired_at' => time()];
};
$raced = drive_resync();
assert_true($raced['data']['outcome'] === 'busy', 'a lock taken just before the insert makes the page back off');
assert_true(count($GLOBALS['webhook_bodies']) === 0, 'the page dispatches nothing when it loses the lock race');
assert_true(
    $GLOBALS['wp_options'][RADIOSO_OPT_RESYNC_LOCK]['token'] === 'other-run',
    'a lock taken just before the insert is not overwritten'
);

// ── The page claims the schedule it runs against ────────────────────────────

// Cron is blocked: the overdue event is never consumed. WordPress counts any past identical
// event as a duplicate of one scheduled soon, so the batch has to clear it before the
// checkpoint, or it schedules nothing and logs a schedule it never wrote.
seed_running_resync();
set_cron_event(time() - 600);
drive_resync();
$next_event = stored_cron_event();
assert_true($next_event !== false && $next_event > time(), 'a page-run batch leaves a fresh event ahead of now');
assert_true(resync_state()['next_run_at'] === $next_event, 'the state records the event the batch scheduled');
assert_true(
    !in_array('A background batch was already scheduled.', log_messages(), true),
    'a page-run batch does not log a schedule it never wrote'
);

// Cron is slow, not blocked: a cron run consumes the overdue event after this request loaded
// the cron array and before its checkpoint. The batch must not trust the event it still sees.
seed_running_resync();
set_cron_event(time() - 600);
wp_begin_request();
$GLOBALS['wp_cron_db'] = [];
$ran = drive_resync(['nonce' => 'nonce-for-radioso_resync_drive'], false);
assert_true($ran['data']['outcome'] === 'ran', 'a batch the page started on a stale cron array still runs');
assert_true(stored_cron_event() !== false, 'a batch whose event cron consumed still leaves the next one scheduled');

// ── A cancel or a lost lock during a batch is honoured ──────────────────────

// Cancel, from another request, while the page's batch is dispatching. This request cached the
// state when it wrote its start checkpoint; only a fresh read sees the cancel.
seed_running_resync();
set_cron_event(time() - 600);
$GLOBALS['on_webhook'] = function ($sent) {
    if ($sent === 5) {
        $GLOBALS['wp_options'][RADIOSO_OPT_RESYNC_STATE]['status'] = 'cancelled';
        $GLOBALS['wp_cron_db'] = [];
    }
};
$cancelled = drive_resync();
$GLOBALS['on_webhook'] = null;
assert_true(resync_state()['status'] === 'cancelled', 'a cancel that lands mid-batch is not written back to running');
assert_true($cancelled['data']['status'] === 'cancelled', 'the response reports the cancel');
assert_true(stored_cron_event() === false, 'a cancelled batch schedules no next batch');
assert_true(resync_state()['offset'] === 0, 'a cancelled batch records no checkpoint');
assert_true(!array_key_exists(RADIOSO_OPT_RESYNC_LOCK, $GLOBALS['wp_options']), 'a cancelled batch releases its lock');

// Another request replaces this batch's lock (it looked stalled) while the batch is dispatching.
seed_running_resync();
set_cron_event(time() - 600);
$GLOBALS['on_webhook'] = function ($sent) {
    if ($sent === 3) {
        $GLOBALS['wp_options'][RADIOSO_OPT_RESYNC_LOCK] = ['token' => 'other-run', 'acquired_at' => time()];
    }
};
drive_resync();
$GLOBALS['on_webhook'] = null;
assert_true(count($GLOBALS['webhook_bodies']) === 3, 'a batch that lost its lock stops dispatching');
assert_true(resync_state()['offset'] === 0, 'a batch that lost its lock records no checkpoint');
assert_true(
    $GLOBALS['wp_options'][RADIOSO_OPT_RESYNC_LOCK]['token'] === 'other-run',
    'a batch that lost its lock leaves the new holder\'s lock alone'
);

// ── Completion ──────────────────────────────────────────────────────────────

seed_running_resync(['total' => 3, 'processed' => 0]);
$GLOBALS['query_posts'] = [1, 2, 3];
set_cron_event(time() - 600);
$finished = drive_resync();
assert_true($finished['data']['outcome'] === 'ran', 'the last batch runs');
assert_true($finished['data']['status'] === 'complete', 'the response reports completion');
assert_true($finished['data']['processed'] === 3 && $finished['data']['total'] === 3, 'a finished resync reports every post');
assert_true(count($GLOBALS['webhook_bodies']) === 3, 'the last batch dispatches the remaining posts');

// A finished resync has nothing left for the page to do.
$GLOBALS['webhook_bodies'] = [];
$after = drive_resync();
assert_true($after['success'] === true && $after['data']['outcome'] === 'idle', 'a finished resync is idle');
assert_true($after['data']['status'] === 'complete', 'an idle response still reports the terminal status');
assert_true(count($GLOBALS['webhook_bodies']) === 0, 'a finished resync dispatches nothing');

// ── Cancelled, failed and stalled runs are left alone ───────────────────────

foreach (['cancelled', 'failed', 'complete_with_errors'] as $terminal) {
    seed_running_resync(['status' => $terminal, 'last_error' => 'The batch stopped.']);
    set_cron_event(time() - 600);
    $idle = drive_resync();
    assert_true($idle['data']['outcome'] === 'idle', "a {$terminal} resync is not driven");
    assert_true($idle['data']['status'] === $terminal, "a {$terminal} resync reports its status");
    assert_true(count($GLOBALS['webhook_bodies']) === 0, "a {$terminal} resync dispatches nothing");
    assert_true($idle['data']['health'] === null, "a {$terminal} resync has no cron health");
}

// A batch that began long ago and never saved a checkpoint needs an administrator, not a retry loop.
seed_running_resync(['batch_started_at' => time() - RADIOSO_RESYNC_STALL_AFTER - 10]);
set_cron_event(time() - 600);
$stalled = drive_resync();
assert_true($stalled['data']['outcome'] === 'stalled', 'a stalled batch is not retried by the page');
assert_true($stalled['data']['health']['level'] === 'error', 'a stalled batch reports an error');
assert_true(count($GLOBALS['webhook_bodies']) === 0, 'a stalled batch dispatches nothing from the page');

// A batch someone else is mid-way through is left to finish.
seed_running_resync(['batch_started_at' => time() - 10]);
set_cron_event(time() - 600);
$running = drive_resync();
assert_true($running['data']['outcome'] === 'busy', 'a batch in flight elsewhere is not doubled');
assert_true(count($GLOBALS['webhook_bodies']) === 0, 'a batch in flight elsewhere dispatches nothing from the page');

// ── Health messages tell the operator the page carries on ───────────────────

foreach ([['No background batch', false], ['overdue', time() - 600]] as [$needle, $scheduled]) {
    set_cron_event($scheduled);
    $health = radioso_resync_cron_health(['status' => 'running', 'batch_started_at' => 0]);
    assert_true(strpos($health['message'], $needle) !== false, "the {$needle} message names the problem");
    assert_true(
        strpos($health['message'], 'while it stays open') !== false,
        "the {$needle} message says the page continues the resync"
    );
    assert_true(
        strpos($health['message'], 'wp-cron.php') !== false,
        "the {$needle} message points unattended runs at a server cron"
    );
}

// ── The page ────────────────────────────────────────────────────────────────

ob_start();
radioso_render_resync_driver();
$markup = str_replace('\\/', '/', ob_get_clean());
assert_true(strpos($markup, 'nonce-for-radioso_resync_drive') !== false, 'the script carries the nonce');
assert_true(strpos($markup, 'https://example.com/wp-admin/admin-ajax.php') !== false, 'the script posts to admin-ajax');
assert_true(strpos($markup, 'radioso_resync_drive') !== false, 'the script names the action');

$GLOBALS['wp_cache'] = null;
$GLOBALS['wp_options'][RADIOSO_OPT_RESYNC_STATE] = ['status' => 'running', 'total' => 45, 'processed' => 20];
set_cron_event(false);
ob_start();
radioso_render_resync_section();
$section = ob_get_clean();
assert_true(strpos($section, 'Resync in progress: 20 / 45 posts') !== false, 'a running resync shows its progress');
assert_true(strpos($section, 'id="radioso-resync-progress"') !== false, 'the progress text is addressable by the script');
assert_true(strpos($section, 'admin-ajax.php') !== false, 'a running resync loads the driving script');
assert_true(strpos($section, 'Run next batch now') !== false, 'the manual button is there when cron is missing');

// The page's stop message points at the button, so a healthy schedule shows it too.
set_cron_event(time() + 30);
ob_start();
radioso_render_resync_section();
$section = ob_get_clean();
assert_true(strpos($section, 'notice-info') !== false, 'a scheduled batch reports info health');
assert_true(strpos($section, 'Run next batch now') !== false, 'the manual button is there while cron looks healthy');

$GLOBALS['wp_options'][RADIOSO_OPT_RESYNC_STATE] = ['status' => 'complete', 'total' => 45, 'processed' => 45];
ob_start();
radioso_render_resync_section();
$section = ob_get_clean();
assert_true(strpos($section, 'admin-ajax.php') === false, 'a finished resync loads no driving script');

echo "PASS: WordPress companion resync driver\n";
