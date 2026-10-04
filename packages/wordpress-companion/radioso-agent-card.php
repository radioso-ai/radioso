<?php
/**
 * Agent discovery for a Radioso-backed site.
 *
 * A visiting AI agent given only the site's hostname looks for its discovery documents at
 * the site's own origin. Radioso hosts the canonical documents per agent, which a shared
 * API host cannot serve at an unscoped path — so this file answers the three site-level
 * paths with a redirect to the customer's canonical Radioso URLs.
 *
 * Loaded by radioso-sync.php. Configure under Settings → Radioso Agent Card; the public
 * agent id is shown in Radioso under Channels → MCP.
 */

if (!defined('ABSPATH')) {
    exit;
}

const RADIOSO_OPT_CARD_API_URL   = 'radioso_agent_card_api_url';
const RADIOSO_OPT_CARD_PUBLIC_ID = 'radioso_agent_card_public_id';

/** Query var carrying which document a matched request wants. */
const RADIOSO_CARD_QUERY_VAR = 'radioso_agent_card';

// ── Hooks ───────────────────────────────────────────────────────────────────

add_action('init', 'radioso_agent_card_register_rewrites');
add_action('template_redirect', 'radioso_agent_card_handle_request');
add_action('admin_init', 'radioso_agent_card_register_settings');
add_action('admin_menu', 'radioso_agent_card_register_menu');
add_action('update_option_' . RADIOSO_OPT_CARD_PUBLIC_ID, 'radioso_agent_card_flush_rewrites');
add_action('update_option_' . RADIOSO_OPT_CARD_API_URL, 'radioso_agent_card_flush_rewrites');

// ── Routing ─────────────────────────────────────────────────────────────────

/**
 * The site-level path each document answers, and the Radioso path it redirects to.
 * `%s` is the public agent id.
 */
function radioso_agent_card_documents() {
    return [
        'agent_card'  => [
            'rule'   => '^\.well-known/agent-card\.json$',
            'target' => '/.well-known/agent-card/%s.json',
        ],
        'server_card' => [
            'rule'   => '^\.well-known/mcp/server-card\.json$',
            'target' => '/.well-known/mcp/server-card/%s.json',
        ],
        'ai_catalog'  => [
            'rule'   => '^\.well-known/ai-catalog\.json$',
            'target' => '/.well-known/ai-catalog/%s.json',
        ],
    ];
}

function radioso_agent_card_register_rewrites() {
    foreach (radioso_agent_card_documents() as $document => $paths) {
        add_rewrite_rule($paths['rule'], 'index.php?' . RADIOSO_CARD_QUERY_VAR . '=' . $document, 'top');
    }
    add_filter('query_vars', 'radioso_agent_card_query_vars');
}

function radioso_agent_card_query_vars($vars) {
    $vars[] = RADIOSO_CARD_QUERY_VAR;
    return $vars;
}

/** Rewrite rules only take effect once WordPress rebuilds them. */
function radioso_agent_card_flush_rewrites() {
    radioso_agent_card_register_rewrites();
    flush_rewrite_rules(false);
}

/**
 * The Radioso URL a document redirects to, or null when the site is not configured for
 * discovery. The public id is bounded to the characters a path segment may carry, so a
 * mistyped setting cannot send a visitor somewhere else.
 */
function radioso_agent_card_target_url($document) {
    $documents = radioso_agent_card_documents();
    if (!isset($documents[$document])) {
        return null;
    }
    $api_url   = trim((string) get_option(RADIOSO_OPT_CARD_API_URL, ''));
    $public_id = trim((string) get_option(RADIOSO_OPT_CARD_PUBLIC_ID, ''));
    if ($api_url === '' || $public_id === '') {
        return null;
    }
    if (!preg_match('#^https?://[^/?\#]+#', $api_url) || !preg_match('/^[A-Za-z0-9_\-]{1,64}$/', $public_id)) {
        return null;
    }
    return rtrim($api_url, '/') . sprintf($documents[$document]['target'], $public_id);
}

/**
 * Answers one matched request. Returns true when it sent a response, so the hook — and
 * only the hook — ends the request.
 */
function radioso_agent_card_redirect($document) {
    if (!$document) {
        return false;
    }
    $target = radioso_agent_card_target_url($document);
    if ($target === null) {
        status_header(404);
        nocache_headers();
        return true;
    }
    wp_redirect($target, 302);
    return true;
}

function radioso_agent_card_handle_request() {
    $document = get_query_var(RADIOSO_CARD_QUERY_VAR);
    if (radioso_agent_card_redirect($document)) {
        exit;
    }
}

// ── Settings ────────────────────────────────────────────────────────────────

function radioso_agent_card_register_settings() {
    register_setting('radioso_agent_card', RADIOSO_OPT_CARD_API_URL, [
        'type'              => 'string',
        'sanitize_callback' => 'esc_url_raw',
        'default'           => '',
    ]);
    register_setting('radioso_agent_card', RADIOSO_OPT_CARD_PUBLIC_ID, [
        'type'              => 'string',
        'sanitize_callback' => 'sanitize_text_field',
        'default'           => '',
    ]);
}

function radioso_agent_card_register_menu() {
    add_options_page(
        'Radioso Agent Card',
        'Radioso Agent Card',
        'manage_options',
        'radioso-agent-card',
        'radioso_agent_card_render_settings_page'
    );
}

function radioso_agent_card_render_settings_page() {
    if (!current_user_can('manage_options')) {
        return;
    }
    ?>
    <div class="wrap">
        <h1>Radioso Agent Card</h1>
        <p>Point this site's discovery paths at its Radioso agent, so a visiting AI agent
           finds the agent from the site's hostname alone. Copy the public agent id from
           Radioso under Channels &rarr; MCP.</p>
        <form method="post" action="options.php">
            <?php settings_fields('radioso_agent_card'); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><label for="<?php echo esc_attr(RADIOSO_OPT_CARD_API_URL); ?>">Radioso API URL</label></th>
                    <td>
                        <input
                            name="<?php echo esc_attr(RADIOSO_OPT_CARD_API_URL); ?>"
                            id="<?php echo esc_attr(RADIOSO_OPT_CARD_API_URL); ?>"
                            type="url"
                            class="regular-text code"
                            value="<?php echo esc_attr(get_option(RADIOSO_OPT_CARD_API_URL, '')); ?>"
                            placeholder="https://api.radioso.ai" />
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="<?php echo esc_attr(RADIOSO_OPT_CARD_PUBLIC_ID); ?>">Public agent id</label></th>
                    <td>
                        <input
                            name="<?php echo esc_attr(RADIOSO_OPT_CARD_PUBLIC_ID); ?>"
                            id="<?php echo esc_attr(RADIOSO_OPT_CARD_PUBLIC_ID); ?>"
                            type="text"
                            class="regular-text code"
                            value="<?php echo esc_attr(get_option(RADIOSO_OPT_CARD_PUBLIC_ID, '')); ?>"
                            placeholder="ag_..." />
                        <p class="description">Leave blank to answer the discovery paths with 404.</p>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>
    </div>
    <?php
}
