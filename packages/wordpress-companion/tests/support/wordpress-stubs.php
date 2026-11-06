<?php
// WordPress and WooCommerce stand-ins shared by the plugin test scripts that load
// radioso-sync.php. Not a test itself: CI runs only tests/*-test.php.

define('ABSPATH', __DIR__);

$GLOBALS['wp_actions'] = [];
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

function add_action($hook, $callback, $priority = 10, $accepted_args = 1) {
    $GLOBALS['wp_actions'][$hook][] = $callback;
}
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
function wp_json_encode($value, $flags = 0) { return json_encode($value, $flags); }
function home_url($path = '') { return 'https://example.com' . $path; }
function get_the_title($post) { return 'Title'; }
$GLOBALS['filters'] = [];
function apply_filters($hook, $value, ...$args) {
    $callback = $GLOBALS['filters'][$hook] ?? null;
    return $callback === null ? $value : $callback($value, ...$args);
}
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
function wc_get_price_to_display($product, $args = []) {
    $price = array_key_exists('price', $args) ? $args['price'] : $product->get_price();
    return $price === '' || $price === null ? '' : (float) $price;
}
function get_woocommerce_currency() { return 'EUR'; }
function wp_get_post_parent_id($post_id) { return $GLOBALS['post_parents'][$post_id] ?? 0; }
// Stands in for a loaded Italian WooCommerce text domain.
function __($text, $domain = '') {
    $italian = ['Price' => 'Prezzo', 'Regular price' => 'Prezzo di listino'];
    return $italian[$text] ?? $text;
}

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
    private $regular_price; private $sale_price; private $stock_status;
    public function __construct(
        $id, $sku, $availability, $attributes, $parent = 0,
        $price = '', $type = 'simple', $variation_prices = [],
        $regular_price = '', $sale_price = '', $stock_status = 'instock'
    ) {
        $this->id = $id; $this->sku = $sku; $this->availability = $availability;
        $this->attributes = $attributes; $this->parent = $parent;
        $this->price = $price; $this->type = $type; $this->variation_prices = $variation_prices;
        $this->regular_price = $regular_price; $this->sale_price = $sale_price;
        $this->stock_status = $stock_status;
    }
    public function get_regular_price() { return $this->regular_price; }
    public function get_sale_price() { return $this->sale_price; }
    public function is_on_sale() { return $this->sale_price !== '' && $this->sale_price !== null; }
    public function get_stock_status() { return $this->stock_status; }
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

function assert_true($condition, $message) {
    if (!$condition) {
        fwrite(STDERR, "FAIL: {$message}\n");
        exit(1);
    }
}
