<?php

define('ABSPATH', __DIR__);

$GLOBALS['wp_options'] = [];
$GLOBALS['scheduled_result'] = true;
$GLOBALS['next_scheduled'] = false;
$GLOBALS['query_posts'] = [];
$GLOBALS['wp_cache_deletes'] = [];
$GLOBALS['before_delete_option'] = null;

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
function delete_option($key) {
    if (is_callable($GLOBALS['before_delete_option'])) {
        $callback = $GLOBALS['before_delete_option'];
        $GLOBALS['before_delete_option'] = null;
        $callback();
    }
    unset($GLOBALS['wp_options'][$key]);
    return true;
}
function maybe_serialize($value) { return is_array($value) ? serialize($value) : $value; }
function wp_cache_delete($key, $group = '') { $GLOBALS['wp_cache_deletes'][] = [$key, $group]; return true; }
function wp_schedule_single_event($timestamp, $hook, $args = [], $wp_error = false) { return $GLOBALS['scheduled_result']; }
function wp_clear_scheduled_hook($hook) { $GLOBALS['next_scheduled'] = false; return 1; }
function wp_next_scheduled($hook) { return $GLOBALS['next_scheduled']; }
function wp_date($format, $timestamp) { return gmdate($format, $timestamp); }
function get_post($id) { if (isset($GLOBALS['posts'][$id])) { return $GLOBALS['posts'][$id]; } return (object) [
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
function wp_remote_post($url, $args) {
    $GLOBALS['last_webhook_body'] = $args['body'];
    $GLOBALS['webhook_bodies'][] = $args['body'];
    return ['response' => ['code' => 204]];
}

// ── Taxonomy + WooCommerce stubs ────────────────────────────────────────────

$GLOBALS['object_taxonomies'] = [];
$GLOBALS['post_terms']        = [];
$GLOBALS['wc_products']       = [];
$GLOBALS['wc_product_terms']  = [];
$GLOBALS['posts']             = [];
$GLOBALS['last_webhook_body'] = null;
$GLOBALS['webhook_bodies']   = [];
$GLOBALS['post_parents']     = [];

function esc_html($value) { return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8'); }
function taxonomy_exists($taxonomy) { return isset($GLOBALS['object_taxonomies'][$taxonomy]); }
function get_object_taxonomies($post_type, $output = 'names') {
    $found = [];
    foreach ($GLOBALS['object_taxonomies'] as $name => $taxonomy) {
        if (in_array($post_type, $taxonomy->object_type, true)) { $found[$name] = $taxonomy; }
    }
    return $found;
}
function get_the_terms($post, $taxonomy) {
    $id = is_object($post) ? $post->ID : $post;
    return $GLOBALS['post_terms'][$id . ':' . $taxonomy] ?? false;
}
function wc_get_product($id) { return $GLOBALS['wc_products'][$id] ?? false; }
function wc_attribute_label($name, $product = null) { return ucfirst(str_replace('pa_', '', $name)); }
function wc_get_product_terms($product_id, $taxonomy, $args = []) {
    return $GLOBALS['wc_product_terms'][$product_id . ':' . $taxonomy] ?? [];
}
// Mirrors WooCommerce: markup, and the currency symbol as an HTML entity.
function wc_price($amount) {
    return '<span class="amount"><bdi><span>&euro;</span>'
        . number_format((float) $amount, 2, ',', '.') . '</bdi></span>';
}
function wc_get_price_to_display($product, $args = []) { return $product->get_price(); }
function wp_get_post_parent_id($post_id) { return $GLOBALS['post_parents'][$post_id] ?? 0; }
// Stands in for a loaded Italian WooCommerce text domain.
function __($text, $domain = '') { return $text === 'Price' ? 'Prezzo' : $text; }

class WC_Attribute_Stub {
    private $name; private $options; private $visible; private $taxonomy;
    public function __construct($name, $options, $visible = true, $taxonomy = false) {
        $this->name = $name; $this->options = $options;
        $this->visible = $visible; $this->taxonomy = $taxonomy;
    }
    public function get_name() { return $this->name; }
    public function get_options() { return $this->options; }
    public function get_visible() { return $this->visible; }
    public function is_taxonomy() { return $this->taxonomy; }
}

class WC_Product_Stub {
    private $id; private $sku; private $availability; private $attributes; private $parent;
    private $price; private $type; private $variation_prices;
    public function __construct(
        $id, $sku, $availability, $attributes, $parent = 0,
        $price = '', $type = 'simple', $variation_prices = []
    ) {
        $this->id = $id; $this->sku = $sku; $this->availability = $availability;
        $this->attributes = $attributes; $this->parent = $parent;
        $this->price = $price; $this->type = $type; $this->variation_prices = $variation_prices;
    }
    public function get_id() { return $this->id; }
    public function get_sku() { return $this->sku; }
    public function get_availability() { return ['availability' => $this->availability]; }
    public function get_attributes() { return $this->attributes; }
    public function get_parent_id() { return $this->parent; }
    public function get_price() { return $this->price; }
    public function is_type($type) { return $this->type === $type; }
    public function get_variation_price($which, $display = false) {
        return $this->variation_prices[$which] ?? '';
    }
}

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

$release_lock = radioso_resync_acquire_lock();
$newer_lock = ['token' => 'newer-release-worker', 'acquired_at' => time()];
$replace_lock = function () use ($newer_lock) {
    $GLOBALS['wp_options'][RADIOSO_OPT_RESYNC_LOCK] = $newer_lock;
};
$GLOBALS['before_delete_option'] = $replace_lock;
$GLOBALS['wpdb']->before_delete = $replace_lock;
radioso_resync_release_lock($release_lock);
assert_true(radioso_resync_owns_lock('newer-release-worker'), 'lock release cannot delete a newer lock');
$GLOBALS['before_delete_option'] = null;
radioso_resync_release_lock('newer-release-worker');

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

// ── Author attribution ──────────────────────────────────────────────────────

$GLOBALS['wp_options'][RADIOSO_OPT_AUTHOR_TAXONOMY] = '';

$editorial_post = (object) ['ID' => 501, 'post_type' => 'post', 'post_author' => 7];
$editorial_author = radioso_author_payload($editorial_post);
assert_true($editorial_author['name'] === 'Author', 'posts keep the WordPress byline');
assert_true($editorial_author['id'] === 7, 'posts carry the WordPress user id');

$catalogue_post = (object) [
    'ID' => 502, 'post_type' => 'product', 'post_status' => 'publish', 'post_name' => 'libro',
    'post_content' => '<p>Descrizione</p>', 'post_excerpt' => '', 'post_author' => 7,
    'post_modified_gmt' => '2026-01-01 00:00:00', 'post_date_gmt' => '2026-01-01 00:00:00',
];
assert_true(
    radioso_author_payload($catalogue_post) === null,
    'catalogue types never publish the uploading account as author'
);

$GLOBALS['object_taxonomies']['autore'] = (object) [
    'name' => 'autore', 'public' => true, 'object_type' => ['product'],
    'labels' => (object) ['singular_name' => 'Autore'],
];
$GLOBALS['post_terms']['502:autore'] = [(object) ['name' => 'Swami Kriyananda']];
$GLOBALS['wp_options'][RADIOSO_OPT_AUTHOR_TAXONOMY] = 'autore';
assert_true(
    radioso_author_payload($catalogue_post) === ['name' => 'Swami Kriyananda'],
    'a configured taxonomy supplies the author with no WordPress user id'
);

// ── Facts block ─────────────────────────────────────────────────────────────

$GLOBALS['object_taxonomies']['product_cat'] = (object) [
    'name' => 'product_cat', 'public' => true, 'object_type' => ['product'],
    'labels' => (object) ['singular_name' => 'Categoria'],
];
$GLOBALS['object_taxonomies']['product_visibility'] = (object) [
    'name' => 'product_visibility', 'public' => false, 'object_type' => ['product'],
    'labels' => (object) ['singular_name' => 'Visibility'],
];
$GLOBALS['post_terms']['502:product_cat'] = [
    (object) ['name' => 'Libri'], (object) ['name' => 'Yoga & <Meditazione>'],
];
$GLOBALS['post_terms']['502:product_visibility'] = [(object) ['name' => 'exclude-from-search']];
$GLOBALS['wc_products'][502] = new WC_Product_Stub(502, 'AEY0112', 'Esaurito', [
    new WC_Attribute_Stub('pa_isbn', ['978-88-6835-000-0']),
    new WC_Attribute_Stub('pa_interno', ['riservato'], false),
], 0, '17');

$facts = radioso_facts_html($catalogue_post);
assert_true(strpos($facts, 'Autore: Swami Kriyananda') !== false, 'facts carry taxonomy terms');
assert_true(
    strpos($facts, 'Categoria: Libri, Yoga &amp; &lt;Meditazione&gt;') !== false,
    'facts escape term names'
);
assert_true(strpos($facts, 'exclude-from-search') === false, 'internal taxonomies stay out of the facts block');
assert_true(strpos($facts, 'SKU: AEY0112') !== false, 'facts carry the SKU');
assert_true(strpos($facts, 'Esaurito') !== false, 'facts carry the availability the shop is claiming');
assert_true(strpos($facts, 'Isbn: 978-88-6835-000-0') !== false, 'facts carry visible product attributes');
assert_true(strpos($facts, 'riservato') === false, 'hidden product attributes stay out of the facts block');
assert_true(strpos($facts, 'Prezzo: €17,00') !== false, 'facts carry the price in the shop language');
assert_true(strpos($facts, '&amp;euro;') === false, 'the currency symbol is not double-encoded');

$variable_post = (object) ['ID' => 505, 'post_type' => 'product'];
$GLOBALS['wc_products'][505] = new WC_Product_Stub(505, 'STAT-1', '', [], 0, '', 'variable', [
    'min' => '20', 'max' => '950',
]);
$variable_facts = radioso_facts_html($variable_post);
assert_true(
    strpos($variable_facts, 'Prezzo: €20,00 – €950,00') !== false,
    'a variable product publishes its price range rather than one number'
);

// ── Dispatched payload ──────────────────────────────────────────────────────

radioso_dispatch('updated', $catalogue_post);
$body = json_decode($GLOBALS['last_webhook_body'], true);
assert_true(
    $body['post']['author']['name'] === 'Swami Kriyananda',
    'dispatch publishes the taxonomy author'
);
assert_true(!isset($body['post']['author']['id']), 'taxonomy author carries no WordPress user id');
assert_true(
    strpos($body['post']['content_rendered'], 'radioso-facts') !== false,
    'dispatch appends the facts block to rendered content'
);
assert_true(
    strpos($body['post']['content_raw'], 'radioso-facts') === false,
    'raw content stays untouched'
);

$GLOBALS['wp_options'][RADIOSO_OPT_AUTHOR_TAXONOMY] = '';
radioso_dispatch('updated', $catalogue_post);
$unattributed = json_decode($GLOBALS['last_webhook_body'], true);
assert_true(
    !array_key_exists('author', $unattributed['post']),
    'a catalogue post with no author taxonomy omits author entirely'
);

// ── Deferred dispatch ───────────────────────────────────────────────────────

$GLOBALS['posts'][502] = $catalogue_post;
$GLOBALS['wp_options'][RADIOSO_OPT_POST_TYPES] = 'product';
$GLOBALS['webhook_bodies'] = [];

// Several hooks fire for one save. Nothing leaves until the request ends, and
// then only once.
radioso_on_transition('publish', 'publish', $catalogue_post);
radioso_on_stock_status_change(502, 'outofstock', $GLOBALS['wc_products'][502]);
radioso_on_product_updated(502);
assert_true(count($GLOBALS['webhook_bodies']) === 0, 'updates wait for the end of the request');

radioso_flush_queued_dispatches();
assert_true(count($GLOBALS['webhook_bodies']) === 1, 'one save produces one push however many hooks it trips');

// The transition hook runs before the save_post pass that writes product meta,
// so the flush has to re-read the post rather than trust the captured object.
$GLOBALS['webhook_bodies'] = [];
$stale = clone $catalogue_post;
$stale->post_content = '<p>Prima della modifica</p>';
radioso_on_transition('publish', 'publish', $stale);
$GLOBALS['posts'][502]->post_content = '<p>Dopo la modifica</p>';
radioso_flush_queued_dispatches();
$flushed = json_decode($GLOBALS['webhook_bodies'][0], true);
assert_true(
    strpos($flushed['post']['content_rendered'], 'Dopo la modifica') !== false,
    'the flush publishes the state the request finished with'
);

// A delete cannot wait for the flush: the post is gone by then.
$GLOBALS['webhook_bodies'] = [];
radioso_on_product_updated(502);
radioso_on_delete(502);
assert_true(count($GLOBALS['webhook_bodies']) === 1, 'a delete dispatches immediately');
$deleted = json_decode($GLOBALS['webhook_bodies'][0], true);
assert_true($deleted['event'] === 'deleted', 'the delete event is the one that goes out');
radioso_flush_queued_dispatches();
assert_true(count($GLOBALS['webhook_bodies']) === 1, 'a delete cancels the update queued for the same post');

$GLOBALS['webhook_bodies'] = [];
$draft = clone $catalogue_post;
$draft->post_status = 'draft';
$GLOBALS['posts'][503] = $draft;
radioso_on_stock_status_change(503, 'outofstock', null);
radioso_flush_queued_dispatches();
assert_true(count($GLOBALS['webhook_bodies']) === 0, 'unpublished products are not pushed on stock changes');

// A variation price change reaches the parent document. WooCommerce rewrites a
// variable product's `_price` directly and announces it with this action, so
// `woocommerce_update_product` never fires for it.
$GLOBALS['webhook_bodies'] = [];
radioso_on_product_price_updated(502);
radioso_flush_queued_dispatches();
assert_true(count($GLOBALS['webhook_bodies']) === 1, 'a synced price range re-pushes the product');

$GLOBALS['webhook_bodies'] = [];
$GLOBALS['post_parents'][507] = 502;
radioso_on_variation_updated(507, null);
radioso_flush_queued_dispatches();
$from_variation = json_decode($GLOBALS['webhook_bodies'][0], true);
assert_true(
    $from_variation['post']['id'] === 502,
    'a variation save re-pushes its parent product, not the variation'
);

// A hook handing over a WC_Product instead of an ID resolves to that product.
// Casting an object to int yields 1 in PHP, so an unguarded handler would push
// post 1 under the product's identity.
$GLOBALS['webhook_bodies'] = [];
radioso_on_product_updated($GLOBALS['wc_products'][502]);
radioso_flush_queued_dispatches();
$from_object = json_decode($GLOBALS['webhook_bodies'][0], true);
assert_true($from_object['post']['id'] === 502, 'a product object argument resolves to that product');

$GLOBALS['webhook_bodies'] = [];
radioso_on_product_updated(null);
radioso_on_product_updated('');
radioso_flush_queued_dispatches();
assert_true(count($GLOBALS['webhook_bodies']) === 0, 'an unusable hook argument queues nothing');

// WooCommerce syncs variable price ranges on shutdown at priority 10; flushing
// before that would publish the previous range.
assert_true(RADIOSO_FLUSH_PRIORITY > 10, 'the flush runs after the WooCommerce deferred product sync');

// ── Posts and pages keep their existing payload ─────────────────────────────

$GLOBALS['wp_options'][RADIOSO_OPT_POST_TYPES] = 'post,page';
$GLOBALS['wp_options'][RADIOSO_OPT_AUTHOR_TAXONOMY] = '';
$GLOBALS['webhook_bodies'] = [];
$plain_post = (object) [
    'ID' => 601, 'post_type' => 'post', 'post_status' => 'publish', 'post_name' => 'articolo',
    'post_content' => '<p>Articolo</p>', 'post_excerpt' => 'sommario', 'post_author' => 7,
    'post_modified_gmt' => '2026-01-01 00:00:00', 'post_date_gmt' => '2026-01-01 00:00:00',
];
$GLOBALS['posts'][601] = $plain_post;
radioso_on_transition('publish', 'publish', $plain_post);
radioso_flush_queued_dispatches();
$plain_body = json_decode($GLOBALS['webhook_bodies'][0], true);
assert_true($plain_body['post']['content_rendered'] === '<p>Articolo</p>', 'a post with no taxonomy terms is pushed unchanged');
assert_true($plain_body['post']['content_raw'] === '<p>Articolo</p>', 'raw content is untouched');
assert_true($plain_body['post']['excerpt_rendered'] === 'sommario', 'the excerpt is still pushed');
assert_true($plain_body['post']['author'] === ['id' => 7, 'name' => 'Author'], 'a post keeps its WordPress byline');

// A post that does carry terms gains them, on the same rule as a catalogue item.
$GLOBALS['object_taxonomies']['category'] = (object) [
    'name' => 'category', 'public' => true, 'object_type' => ['post'],
    'labels' => (object) ['singular_name' => 'Categoria'],
];
$GLOBALS['post_terms']['601:category'] = [(object) ['name' => 'Yoga']];
$GLOBALS['webhook_bodies'] = [];
radioso_on_transition('publish', 'publish', $plain_post);
radioso_flush_queued_dispatches();
$categorised = json_decode($GLOBALS['webhook_bodies'][0], true);
assert_true(
    strpos($categorised['post']['content_rendered'], 'Categoria: Yoga') !== false,
    'a categorised post carries its terms in the facts block'
);

echo "PASS: WordPress companion status behavior\n";
