<?php
// Hand-rolled like status-test.php: stub the WordPress functions the file touches, load it,
// and call its functions directly. Run with `php packages/wordpress-companion/tests/agent-card-test.php`.

define('ABSPATH', __DIR__);

$GLOBALS['wp_options']   = [];
$GLOBALS['rewrite_rules'] = [];
$GLOBALS['filters']      = [];
$GLOBALS['redirects']    = [];
$GLOBALS['status_codes'] = [];

function add_action(...$args) {}
function add_filter($hook, $callback, $priority = 10, $accepted_args = 1) { $GLOBALS['filters'][$hook][] = $callback; }
function add_rewrite_rule($regex, $query, $after = 'bottom') { $GLOBALS['rewrite_rules'][$regex] = $query; }
function flush_rewrite_rules($hard = true) { $GLOBALS['flushed'] = true; }
function get_option($key, $default = false) { return $GLOBALS['wp_options'][$key] ?? $default; }
function sanitize_text_field($value) { return trim(strip_tags((string) $value)); }
function esc_url_raw($value) { return (string) $value; }
function esc_attr($value) { return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8'); }
function wp_redirect($location, $status = 302) { $GLOBALS['redirects'][] = [$location, $status]; return true; }
function status_header($code) { $GLOBALS['status_codes'][] = $code; }
function nocache_headers() {}
function register_setting($group, $name, $args = []) {}
function add_options_page(...$args) {}
function current_user_can($capability) { return true; }
function settings_fields($group) {}
function submit_button() {}
function get_query_var($var, $default = '') { return $GLOBALS['query_vars'][$var] ?? $default; }

require __DIR__ . '/../radioso-agent-card.php';

function assert_true($condition, $message) {
    if (!$condition) {
        fwrite(STDERR, "FAIL: $message\n");
        exit(1);
    }
}

// An unconfigured site publishes nothing and answers the paths with 404.
assert_true(radioso_agent_card_target_url('agent_card') === null, 'an unconfigured site has no card URL');
assert_true(radioso_agent_card_redirect('agent_card') === true, 'an unconfigured site still answers the request');
assert_true($GLOBALS['status_codes'] === [404], 'an unconfigured site answers 404');
assert_true($GLOBALS['redirects'] === [], 'an unconfigured site redirects nowhere');

$GLOBALS['wp_options'][RADIOSO_OPT_CARD_API_URL]   = 'https://api.radioso.ai/';
$GLOBALS['wp_options'][RADIOSO_OPT_CARD_PUBLIC_ID] = 'ag_QmFzZTY0dXJsSWRlbnQxMg';

assert_true(
    radioso_agent_card_target_url('agent_card') === 'https://api.radioso.ai/.well-known/agent-card/ag_QmFzZTY0dXJsSWRlbnQxMg.json',
    'the agent card redirects to its Radioso canonical'
);
assert_true(
    radioso_agent_card_target_url('server_card') === 'https://api.radioso.ai/.well-known/mcp/server-card/ag_QmFzZTY0dXJsSWRlbnQxMg.json',
    'the server card redirects to its Radioso canonical'
);
assert_true(
    radioso_agent_card_target_url('ai_catalog') === 'https://api.radioso.ai/.well-known/ai-catalog/ag_QmFzZTY0dXJsSWRlbnQxMg.json',
    'the catalog redirects to its Radioso canonical'
);
assert_true(radioso_agent_card_target_url('something_else') === null, 'an unknown document has no URL');

// A mistyped id must never turn a discovery path into an open redirect or a path traversal.
$GLOBALS['wp_options'][RADIOSO_OPT_CARD_PUBLIC_ID] = '../../evil';
assert_true(radioso_agent_card_target_url('agent_card') === null, 'a public id outside the allowed characters is refused');

$GLOBALS['wp_options'][RADIOSO_OPT_CARD_PUBLIC_ID] = 'ag_QmFzZTY0dXJsSWRlbnQxMg';
$GLOBALS['wp_options'][RADIOSO_OPT_CARD_API_URL]   = 'javascript:alert(1)';
assert_true(radioso_agent_card_target_url('agent_card') === null, 'a non-HTTP API URL is refused');

$GLOBALS['wp_options'][RADIOSO_OPT_CARD_API_URL] = 'https://api.radioso.ai';
$GLOBALS['redirects'] = [];
$GLOBALS['query_vars'] = [RADIOSO_CARD_QUERY_VAR => 'agent_card'];
assert_true(radioso_agent_card_redirect(get_query_var(RADIOSO_CARD_QUERY_VAR)) === true, 'a matched request is answered');
assert_true(
    $GLOBALS['redirects'] === [['https://api.radioso.ai/.well-known/agent-card/ag_QmFzZTY0dXJsSWRlbnQxMg.json', 302]],
    'a configured site sends a 302 to the canonical card'
);

assert_true(radioso_agent_card_redirect('') === false, 'an unmatched request is left to WordPress');

radioso_agent_card_register_rewrites();
assert_true(count($GLOBALS['rewrite_rules']) === 3, 'three site-level discovery paths are routed');
assert_true(
    $GLOBALS['rewrite_rules']['^\.well-known/agent-card\.json$'] === 'index.php?radioso_agent_card=agent_card',
    'the agent card path routes to the agent card document'
);
assert_true(in_array('radioso_agent_card', radioso_agent_card_query_vars([]), true), 'the query var is registered');

echo "PASS: WordPress companion agent card behavior\n";
