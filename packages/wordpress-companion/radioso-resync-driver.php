<?php
/**
 * Keeps a bulk resync going from the open settings page when WP-Cron cannot fire.
 *
 * The resync advances one batch per WP-Cron event. A site whose own loopback request to
 * wp-cron.php is blocked (a bot-protection rule, an authentication wall) never runs the
 * event, so the resync stalls until someone clicks "Run next batch now" for every batch.
 * While the settings page is open, its script asks this file's admin-ajax action to run
 * one batch whenever the background batch is overdue or missing.
 *
 * Loaded by radioso-sync.php, which owns the batch, the lock, and the cron health rule.
 * This file decides only whether the page should run a batch now, and reports progress.
 */

if (!defined('ABSPATH')) {
    exit;
}

const RADIOSO_RESYNC_DRIVE_ACTION = 'radioso_resync_drive';
/** How long the page waits before asking again when it has nothing to run. */
const RADIOSO_RESYNC_POLL_SECONDS = 10;
/** How long the page waits before asking again when another batch holds the lock. */
const RADIOSO_RESYNC_BUSY_SECONDS = 5;

add_action('wp_ajax_' . RADIOSO_RESYNC_DRIVE_ACTION, 'radioso_resync_drive_ajax');

// ── Admin-ajax handler ──────────────────────────────────────────────────────

function radioso_resync_drive_ajax() {
    if (!current_user_can('manage_options')) {
        wp_send_json_error(['message' => 'You are not allowed to run a content resync.'], 403);
    }
    check_ajax_referer(RADIOSO_RESYNC_DRIVE_ACTION, 'nonce');

    $takeover = isset($_POST['takeover']) && $_POST['takeover'] === '1';
    $outcome = radioso_resync_drive_outcome($takeover);
    wp_send_json_success(radioso_resync_drive_payload($outcome));
}

/**
 * Runs at most one batch and says what happened:
 *   ran     - this request ran a batch
 *   busy    - another batch holds the lock or is mid-flight; nothing was run
 *   waiting - the background batch is not overdue, so WP-Cron keeps it
 *   stalled - a batch began long ago and never checkpointed; an administrator decides
 *   idle    - no resync is running
 *
 * $takeover is the page saying it already ran a batch for this resync because cron
 * did not. Its next batch is due at the time the previous one scheduled, not a minute later.
 */
function radioso_resync_drive_outcome($takeover) {
    $state = get_option(RADIOSO_OPT_RESYNC_STATE, []);
    $health = radioso_resync_cron_health($state);
    if ($health === null) {
        return 'idle';
    }
    if ($health['phase'] === 'stalled') {
        return 'stalled';
    }
    if ($health['phase'] === 'running' || radioso_resync_lock_is_active()) {
        return 'busy';
    }
    if (!radioso_resync_batch_is_due($health, $takeover)) {
        return 'waiting';
    }
    return radioso_run_resync_batch(false) ? 'ran' : 'busy';
}

function radioso_resync_batch_is_due($health, $takeover) {
    if (in_array($health['phase'], ['missing', 'overdue'], true)) {
        return true;
    }
    return $takeover
        && $health['phase'] === 'scheduled'
        && $health['next_run_at'] <= time();
}

function radioso_resync_drive_payload($outcome) {
    $state = get_option(RADIOSO_OPT_RESYNC_STATE, []);
    if (!is_array($state)) {
        $state = [];
    }
    $health = radioso_resync_cron_health($state);

    return [
        'outcome'         => $outcome,
        'status'          => isset($state['status']) ? (string) $state['status'] : 'idle',
        'offset'          => isset($state['offset']) ? (int) $state['offset'] : 0,
        'processed'       => isset($state['processed']) ? (int) $state['processed'] : 0,
        'total'           => isset($state['total']) ? (int) $state['total'] : 0,
        'dispatch_errors' => isset($state['dispatch_errors']) ? (int) $state['dispatch_errors'] : 0,
        'progress'        => radioso_resync_progress_text($state),
        'health'          => $health === null
            ? null
            : ['level' => $health['level'], 'message' => $health['message']],
        'retry_after'     => radioso_resync_drive_retry_after($outcome),
    ];
}

function radioso_resync_drive_retry_after($outcome) {
    if ($outcome === 'busy') {
        return RADIOSO_RESYNC_BUSY_SECONDS;
    }
    $now = time();
    $next_run_at = wp_next_scheduled('radioso_resync_batch');
    if ($next_run_at !== false && $next_run_at > $now) {
        return (int) min($next_run_at - $now + 1, RADIOSO_RESYNC_POLL_SECONDS);
    }
    // A batch the page just ran against an event that is already due has another one waiting.
    return $outcome === 'ran' ? 1 : RADIOSO_RESYNC_POLL_SECONDS;
}

function radioso_resync_progress_text($state) {
    return sprintf(
        'Resync in progress: %d / %d posts',
        isset($state['processed']) ? (int) $state['processed'] : 0,
        isset($state['total']) ? (int) $state['total'] : 0
    );
}

// ── Settings page ───────────────────────────────────────────────────────────

/** Prints the page's status line, its error notice, and the script that calls the handler. */
function radioso_render_resync_driver() {
    $config = [
        'url'    => admin_url('admin-ajax.php'),
        'action' => RADIOSO_RESYNC_DRIVE_ACTION,
        'nonce'  => wp_create_nonce(RADIOSO_RESYNC_DRIVE_ACTION),
    ];
    ?>
    <p id="radioso-resync-driver" class="description" role="status" aria-live="polite"></p>
    <div id="radioso-resync-driver-error" class="notice notice-error inline" role="alert" style="display: none;"><p></p></div>
    <?php
    wp_print_inline_script_tag(str_replace(
        '__RADIOSO_CONFIG__',
        wp_json_encode($config, JSON_HEX_TAG | JSON_HEX_AMP),
        radioso_resync_driver_script()
    ));
}

function radioso_resync_driver_script() {
    return <<<'JS'
(function () {
    var config = __RADIOSO_CONFIG__;
    var progress = document.getElementById('radioso-resync-progress');
    var health = document.getElementById('radioso-resync-health');
    var note = document.getElementById('radioso-resync-driver');
    var failure = document.getElementById('radioso-resync-driver-error');
    if (!progress || !health || !note || !failure || !window.fetch || !window.URLSearchParams) {
        return;
    }

    // Set once this page has run a batch because WP-Cron did not.
    var takeover = false;

    function stop(message) {
        note.textContent = '';
        failure.querySelector('p').textContent = message + ' Reload this page to try again, or use “Run next batch now”.';
        failure.style.display = '';
    }

    function describe(result) {
        if (result.json && result.json.data && result.json.data.message) {
            return result.json.data.message;
        }
        if (result.status === 403) {
            return 'WordPress rejected the request, usually because this page has been open for a long time.';
        }
        return 'WordPress answered with an unexpected response (HTTP ' + result.status + ').';
    }

    function showHealth(info) {
        if (!info) {
            return;
        }
        var level = info.level === 'error' ? 'notice-error' : (info.level === 'warning' ? 'notice-warning' : 'notice-info');
        health.className = 'notice inline ' + level;
        health.querySelector('p').textContent = info.message;
    }

    function handle(data) {
        progress.textContent = data.progress;
        showHealth(data.health);
        if (data.status !== 'running') {
            // The server-rendered page shows the final state and the activity log.
            window.location.reload();
            return;
        }
        if (data.outcome === 'stalled') {
            stop('The current batch has stalled.');
            return;
        }
        if (data.outcome === 'ran') {
            takeover = true;
            note.textContent = 'WP-Cron has not run the next batch, so this page is running it. The resync continues while this page stays open.';
        } else if (data.outcome === 'busy') {
            note.textContent = 'Another batch is running. Checking again shortly.';
        } else if (!takeover) {
            note.textContent = '';
        }
        window.setTimeout(step, Math.max(1, data.retry_after) * 1000);
    }

    function step() {
        var body = new URLSearchParams();
        body.set('action', config.action);
        body.set('nonce', config.nonce);
        if (takeover) {
            body.set('takeover', '1');
        }
        fetch(config.url, { method: 'POST', credentials: 'same-origin', body: body })
            .then(function (response) {
                var result = { ok: response.ok, status: response.status, json: null };
                return response.json().then(
                    function (json) { result.json = json; return result; },
                    function () { return result; }
                );
            })
            .then(function (result) {
                if (!result.ok || !result.json || !result.json.success) {
                    throw new Error(describe(result));
                }
                handle(result.json.data);
            })
            .catch(function (error) {
                stop('This page stopped running the resync. ' + error.message);
            });
    }

    step();
})();
JS;
}
