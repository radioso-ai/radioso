/**
 * Reference labelling for the facet-quality gate (spec 956, T011): one row per
 * question in the recorded corpus, carrying the labels the gate scores against.
 *
 * The question text itself is deliberately absent. This corpus is real
 * pre-production traffic to a single customer workspace, and the gate never
 * reads the text — it clusters the embeddings in `recorded.json` and compares
 * the result to `topic` and `crossLingualGroup` here. Committing the visitor
 * messages would put a customer's end users in the repository to no test-facing
 * end, so the text lives outside version control and only the labels and the
 * recorded geometry are committed. `scripts/dev/facetQualitySourceCorpus.ts`
 * documents where the record scripts expect to find it.
 *
 * Corpus provenance: harvested via `GET /api/v1/history` against the live
 * pre-prod API (152 history entries; 150 were chat conversations, 2 were
 * unrelated search-log entries), then every visitor/user-role message across all
 * 150 conversation details was collected (458 messages), filtered to length
 * 15-300 characters, deduped (case/whitespace-normalized exact duplicates, then
 * a small number of same-language/same-intent trivial near-duplicates), and
 * scanned for PII by an LLM pass plus a human review of every flag (emails,
 * phone numbers, personal names used as the subject of a personal situation,
 * postal addresses, booking references, and other identifying detail were
 * dropped). `topic` and `crossLingualGroup` were assigned by gpt-5.2 from the
 * question text ALONE — the labeller never saw a facet, so labels are not biased
 * toward the facet representation. The taxonomy this was labelled against is
 * committed alongside this file in `taxonomy.json`.
 *
 * `crossLingualGroup` marks intents that occurred, unprompted, in two or more
 * languages in real traffic — found by grouping same-intent labels across
 * languages, not authored by hand. Real traffic yields far fewer such groups than
 * the hand-authored predecessor of this fixture did, and skews heavily towards
 * English and Italian, the two languages this workspace runs an embed agent in.
 *
 * `topic: null` marks a real outlier: either a message the taxonomy pass judged
 * did not fit any topic well, or genuine adversarial/off-topic/fragment traffic.
 * Outliers are clustered along with everything else, matching real conditions,
 * but excluded from the scored partition.
 */

export type FacetQualityTopic =
  | "retreats_courses_calendar_booking"
  | "kriya_yoga_initiation_path"
  | "meditation_guidance_live_sessions"
  | "yoga_practice_videos_routines"
  | "locations_local_groups_sangha"
  | "volunteering_seva_work_exchange_jobs"
  | "travel_pilgrimages_assisi_logistics"
  | "online_courses_platform_access_payments"
  | "community_media_newsletter_social"
  | "teachings_philosophy_spiritual_questions"
  | "people_lineage_and_controversies"
  | "wellness_products_sprays";

export type FacetQualityLanguage = "en" | "es" | "it" | "ru";

export interface FacetQualityQuestion {
  /** Joins to `recorded.json` and to the out-of-tree source corpus. */
  id: string;
  language: FacetQualityLanguage;
  /** LLM-assigned reference topic from question text alone; `null` marks a real outlier. */
  topic: FacetQualityTopic | null;
  /** Same intent occurring in more than one language in real traffic. Defines the multilingual subset. */
  crossLingualGroup?: string;
}

export const facetQualityQuestions: readonly FacetQualityQuestion[] = [
  // --- retreats_courses_calendar_booking — Retreats/courses schedule & booking -
  { id: "bok-01", language: "en", topic: "retreats_courses_calendar_booking" },
  { id: "bok-02", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-03", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-04", language: "en", topic: "retreats_courses_calendar_booking" },
  { id: "bok-05", language: "en", topic: "retreats_courses_calendar_booking" },
  { id: "bok-06", language: "en", topic: "retreats_courses_calendar_booking" },
  { id: "bok-07", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-08", language: "en", topic: "retreats_courses_calendar_booking" },
  { id: "bok-09", language: "en", topic: "retreats_courses_calendar_booking" },
  { id: "bok-10", language: "en", topic: "retreats_courses_calendar_booking" },
  { id: "bok-11", language: "en", topic: "retreats_courses_calendar_booking" },
  { id: "bok-12", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-13", language: "en", topic: "retreats_courses_calendar_booking" },
  { id: "bok-14", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-15", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-16", language: "en", topic: "retreats_courses_calendar_booking" },
  { id: "bok-17", language: "en", topic: "retreats_courses_calendar_booking" },
  { id: "bok-18", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-19", language: "en", topic: "retreats_courses_calendar_booking" },
  { id: "bok-20", language: "en", topic: "retreats_courses_calendar_booking" },
  { id: "bok-21", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-22", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-23", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-24", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-25", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-26", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-27", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-28", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-29", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-30", language: "en", topic: "retreats_courses_calendar_booking" },
  { id: "bok-31", language: "en", topic: "retreats_courses_calendar_booking" },
  { id: "bok-32", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-33", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-34", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-35", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-36", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-37", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-38", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-39", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-40", language: "it", topic: "retreats_courses_calendar_booking" },
  { id: "bok-41", language: "en", topic: "retreats_courses_calendar_booking" },
  { id: "bok-42", language: "en", topic: "retreats_courses_calendar_booking" },
  { id: "bok-43", language: "en", topic: "retreats_courses_calendar_booking" },
  { id: "bok-44", language: "en", topic: "retreats_courses_calendar_booking" },
  { id: "bok-45", language: "en", topic: "retreats_courses_calendar_booking" },
  { id: "bok-46", language: "en", topic: "retreats_courses_calendar_booking" },
  // --- kriya_yoga_initiation_path — Kriya Yoga path & initiation -------------
  { id: "kry-01", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-02", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-03", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-04", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-05", language: "it", topic: "kriya_yoga_initiation_path", crossLingualGroup: "what-is-kriya-yoga" },
  { id: "kry-06", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-07", language: "en", topic: "kriya_yoga_initiation_path" },
  { id: "kry-08", language: "en", topic: "kriya_yoga_initiation_path", crossLingualGroup: "kriya-august-dates" },
  { id: "kry-09", language: "it", topic: "kriya_yoga_initiation_path", crossLingualGroup: "kriya-august-dates" },
  { id: "kry-10", language: "en", topic: "kriya_yoga_initiation_path", crossLingualGroup: "what-is-kriya-yoga" },
  { id: "kry-11", language: "en", topic: "kriya_yoga_initiation_path" },
  { id: "kry-12", language: "en", topic: "kriya_yoga_initiation_path" },
  { id: "kry-13", language: "en", topic: "kriya_yoga_initiation_path" },
  { id: "kry-14", language: "en", topic: "kriya_yoga_initiation_path" },
  { id: "kry-15", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-16", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-17", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-18", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-19", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-20", language: "en", topic: "kriya_yoga_initiation_path" },
  { id: "kry-21", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-22", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-23", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-24", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-25", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-26", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-27", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-28", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-29", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-30", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-31", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-32", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-33", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-34", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-35", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-36", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-37", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-38", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-39", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-40", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-41", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-42", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-43", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-44", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-45", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-46", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-47", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-48", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-49", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-50", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-51", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-52", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-53", language: "it", topic: "kriya_yoga_initiation_path" },
  { id: "kry-54", language: "ru", topic: "kriya_yoga_initiation_path" },
  { id: "kry-55", language: "en", topic: "kriya_yoga_initiation_path" },
  { id: "kry-56", language: "en", topic: "kriya_yoga_initiation_path" },
  // --- meditation_guidance_live_sessions — Meditation guidance & live meditations -
  { id: "mdt-01", language: "en", topic: "meditation_guidance_live_sessions" },
  { id: "mdt-02", language: "en", topic: "meditation_guidance_live_sessions" },
  { id: "mdt-03", language: "it", topic: "meditation_guidance_live_sessions" },
  { id: "mdt-04", language: "it", topic: "meditation_guidance_live_sessions" },
  { id: "mdt-05", language: "it", topic: "meditation_guidance_live_sessions" },
  { id: "mdt-06", language: "it", topic: "meditation_guidance_live_sessions" },
  { id: "mdt-07", language: "it", topic: "meditation_guidance_live_sessions" },
  { id: "mdt-08", language: "it", topic: "meditation_guidance_live_sessions" },
  { id: "mdt-09", language: "it", topic: "meditation_guidance_live_sessions" },
  { id: "mdt-10", language: "it", topic: "meditation_guidance_live_sessions" },
  { id: "mdt-11", language: "it", topic: "meditation_guidance_live_sessions" },
  { id: "mdt-12", language: "it", topic: "meditation_guidance_live_sessions" },
  { id: "mdt-13", language: "it", topic: "meditation_guidance_live_sessions" },
  { id: "mdt-14", language: "it", topic: "meditation_guidance_live_sessions", crossLingualGroup: "meditate-with-me" },
  { id: "mdt-15", language: "en", topic: "meditation_guidance_live_sessions", crossLingualGroup: "meditate-with-me" },
  { id: "mdt-16", language: "en", topic: "meditation_guidance_live_sessions" },
  { id: "mdt-17", language: "es", topic: "meditation_guidance_live_sessions" },
  { id: "mdt-18", language: "es", topic: "meditation_guidance_live_sessions" },
  { id: "mdt-19", language: "it", topic: "meditation_guidance_live_sessions" },
  { id: "mdt-20", language: "it", topic: "meditation_guidance_live_sessions" },
  { id: "mdt-21", language: "it", topic: "meditation_guidance_live_sessions" },
  { id: "mdt-22", language: "it", topic: "meditation_guidance_live_sessions" },
  { id: "mdt-23", language: "it", topic: "meditation_guidance_live_sessions" },
  { id: "mdt-24", language: "it", topic: "meditation_guidance_live_sessions" },
  { id: "mdt-25", language: "it", topic: "meditation_guidance_live_sessions" },
  // --- yoga_practice_videos_routines — Yoga practice content (asanas, routines, videos) -
  { id: "yga-01", language: "it", topic: "yoga_practice_videos_routines" },
  { id: "yga-02", language: "en", topic: "yoga_practice_videos_routines" },
  { id: "yga-03", language: "it", topic: "yoga_practice_videos_routines" },
  { id: "yga-04", language: "it", topic: "yoga_practice_videos_routines" },
  { id: "yga-05", language: "it", topic: "yoga_practice_videos_routines" },
  { id: "yga-06", language: "it", topic: "yoga_practice_videos_routines" },
  { id: "yga-07", language: "it", topic: "yoga_practice_videos_routines" },
  { id: "yga-08", language: "it", topic: "yoga_practice_videos_routines" },
  { id: "yga-09", language: "it", topic: "yoga_practice_videos_routines" },
  { id: "yga-10", language: "it", topic: "yoga_practice_videos_routines" },
  { id: "yga-11", language: "it", topic: "yoga_practice_videos_routines" },
  // --- locations_local_groups_sangha — Locations, local groups & sangha connections -
  { id: "loc-01", language: "en", topic: "locations_local_groups_sangha" },
  { id: "loc-02", language: "en", topic: "locations_local_groups_sangha" },
  { id: "loc-03", language: "en", topic: "locations_local_groups_sangha" },
  { id: "loc-04", language: "en", topic: "locations_local_groups_sangha" },
  { id: "loc-05", language: "en", topic: "locations_local_groups_sangha" },
  { id: "loc-06", language: "en", topic: "locations_local_groups_sangha" },
  { id: "loc-07", language: "en", topic: "locations_local_groups_sangha" },
  { id: "loc-08", language: "it", topic: "locations_local_groups_sangha" },
  { id: "loc-09", language: "en", topic: "locations_local_groups_sangha" },
  { id: "loc-10", language: "it", topic: "locations_local_groups_sangha" },
  { id: "loc-11", language: "it", topic: "locations_local_groups_sangha" },
  { id: "loc-12", language: "en", topic: "locations_local_groups_sangha" },
  { id: "loc-13", language: "en", topic: "locations_local_groups_sangha" },
  { id: "loc-14", language: "en", topic: "locations_local_groups_sangha" },
  { id: "loc-15", language: "it", topic: "locations_local_groups_sangha" },
  { id: "loc-16", language: "it", topic: "locations_local_groups_sangha" },
  { id: "loc-17", language: "en", topic: "locations_local_groups_sangha" },
  { id: "loc-18", language: "en", topic: "locations_local_groups_sangha" },
  { id: "loc-19", language: "es", topic: "locations_local_groups_sangha" },
  { id: "loc-20", language: "it", topic: "locations_local_groups_sangha" },
  { id: "loc-21", language: "it", topic: "locations_local_groups_sangha" },
  { id: "loc-22", language: "it", topic: "locations_local_groups_sangha" },
  { id: "loc-23", language: "it", topic: "locations_local_groups_sangha" },
  { id: "loc-24", language: "en", topic: "locations_local_groups_sangha" },
  { id: "loc-25", language: "it", topic: "locations_local_groups_sangha" },
  // --- volunteering_seva_work_exchange_jobs — Volunteering (seva) & working at the organization -
  { id: "sev-01", language: "en", topic: "volunteering_seva_work_exchange_jobs" },
  { id: "sev-02", language: "it", topic: "volunteering_seva_work_exchange_jobs" },
  { id: "sev-03", language: "en", topic: "volunteering_seva_work_exchange_jobs" },
  { id: "sev-04", language: "en", topic: "volunteering_seva_work_exchange_jobs" },
  { id: "sev-05", language: "it", topic: "volunteering_seva_work_exchange_jobs" },
  { id: "sev-06", language: "it", topic: "volunteering_seva_work_exchange_jobs" },
  // --- travel_pilgrimages_assisi_logistics — Pilgrimages/travel & on-site logistics (esp. Assisi/India) -
  { id: "trv-01", language: "it", topic: "travel_pilgrimages_assisi_logistics" },
  { id: "trv-02", language: "it", topic: "travel_pilgrimages_assisi_logistics" },
  { id: "trv-03", language: "it", topic: "travel_pilgrimages_assisi_logistics" },
  { id: "trv-04", language: "it", topic: "travel_pilgrimages_assisi_logistics" },
  { id: "trv-05", language: "it", topic: "travel_pilgrimages_assisi_logistics" },
  { id: "trv-06", language: "it", topic: "travel_pilgrimages_assisi_logistics" },
  { id: "trv-07", language: "it", topic: "travel_pilgrimages_assisi_logistics" },
  { id: "trv-08", language: "it", topic: "travel_pilgrimages_assisi_logistics" },
  { id: "trv-09", language: "it", topic: "travel_pilgrimages_assisi_logistics" },
  { id: "trv-10", language: "it", topic: "travel_pilgrimages_assisi_logistics" },
  { id: "trv-11", language: "it", topic: "travel_pilgrimages_assisi_logistics" },
  { id: "trv-12", language: "it", topic: "travel_pilgrimages_assisi_logistics" },
  { id: "trv-13", language: "it", topic: "travel_pilgrimages_assisi_logistics" },
  { id: "trv-14", language: "it", topic: "travel_pilgrimages_assisi_logistics" },
  { id: "trv-15", language: "en", topic: "travel_pilgrimages_assisi_logistics" },
  // --- online_courses_platform_access_payments — Online courses platform, access & payments -
  { id: "onl-01", language: "en", topic: "online_courses_platform_access_payments" },
  { id: "onl-02", language: "it", topic: "online_courses_platform_access_payments" },
  { id: "onl-03", language: "it", topic: "online_courses_platform_access_payments" },
  { id: "onl-04", language: "it", topic: "online_courses_platform_access_payments" },
  { id: "onl-05", language: "it", topic: "online_courses_platform_access_payments" },
  { id: "onl-06", language: "it", topic: "online_courses_platform_access_payments" },
  { id: "onl-07", language: "it", topic: "online_courses_platform_access_payments" },
  { id: "onl-08", language: "it", topic: "online_courses_platform_access_payments" },
  { id: "onl-09", language: "it", topic: "online_courses_platform_access_payments" },
  { id: "onl-10", language: "it", topic: "online_courses_platform_access_payments" },
  { id: "onl-11", language: "it", topic: "online_courses_platform_access_payments" },
  { id: "onl-12", language: "it", topic: "online_courses_platform_access_payments" },
  { id: "onl-13", language: "it", topic: "online_courses_platform_access_payments" },
  { id: "onl-14", language: "en", topic: "online_courses_platform_access_payments" },
  { id: "onl-15", language: "it", topic: "online_courses_platform_access_payments" },
  { id: "onl-16", language: "en", topic: "online_courses_platform_access_payments" },
  { id: "onl-17", language: "en", topic: "online_courses_platform_access_payments" },
  // --- community_media_newsletter_social — Media, social channels, newsletters & site navigation -
  { id: "cmm-01", language: "it", topic: "community_media_newsletter_social" },
  { id: "cmm-02", language: "en", topic: "community_media_newsletter_social" },
  { id: "cmm-03", language: "it", topic: "community_media_newsletter_social" },
  { id: "cmm-04", language: "en", topic: "community_media_newsletter_social" },
  { id: "cmm-05", language: "en", topic: "community_media_newsletter_social" },
  { id: "cmm-06", language: "en", topic: "community_media_newsletter_social", crossLingualGroup: "what-is-this-page-about" },
  { id: "cmm-07", language: "en", topic: "community_media_newsletter_social" },
  { id: "cmm-08", language: "en", topic: "community_media_newsletter_social" },
  { id: "cmm-09", language: "en", topic: "community_media_newsletter_social" },
  { id: "cmm-10", language: "en", topic: "community_media_newsletter_social" },
  { id: "cmm-11", language: "en", topic: "community_media_newsletter_social" },
  { id: "cmm-12", language: "it", topic: "community_media_newsletter_social" },
  { id: "cmm-13", language: "it", topic: "community_media_newsletter_social" },
  { id: "cmm-14", language: "en", topic: "community_media_newsletter_social", crossLingualGroup: "do-you-have-social-profiles" },
  { id: "cmm-15", language: "en", topic: "community_media_newsletter_social" },
  { id: "cmm-16", language: "it", topic: "community_media_newsletter_social", crossLingualGroup: "do-you-have-social-profiles" },
  { id: "cmm-17", language: "it", topic: "community_media_newsletter_social" },
  { id: "cmm-18", language: "it", topic: "community_media_newsletter_social" },
  { id: "cmm-19", language: "it", topic: "community_media_newsletter_social" },
  { id: "cmm-20", language: "it", topic: "community_media_newsletter_social" },
  { id: "cmm-21", language: "en", topic: "community_media_newsletter_social" },
  { id: "cmm-22", language: "it", topic: "community_media_newsletter_social", crossLingualGroup: "whats-new-at-the-centre" },
  { id: "cmm-23", language: "en", topic: "community_media_newsletter_social", crossLingualGroup: "whats-new-at-the-centre" },
  { id: "cmm-24", language: "en", topic: "community_media_newsletter_social" },
  { id: "cmm-25", language: "en", topic: "community_media_newsletter_social" },
  { id: "cmm-26", language: "en", topic: "community_media_newsletter_social" },
  { id: "cmm-27", language: "en", topic: "community_media_newsletter_social", crossLingualGroup: "latest-blog-post" },
  { id: "cmm-28", language: "it", topic: "community_media_newsletter_social" },
  { id: "cmm-29", language: "it", topic: "community_media_newsletter_social" },
  { id: "cmm-30", language: "it", topic: "community_media_newsletter_social", crossLingualGroup: "latest-blog-post" },
  { id: "cmm-31", language: "en", topic: "community_media_newsletter_social" },
  { id: "cmm-32", language: "en", topic: "community_media_newsletter_social" },
  { id: "cmm-33", language: "en", topic: "community_media_newsletter_social" },
  { id: "cmm-34", language: "en", topic: "community_media_newsletter_social" },
  { id: "cmm-35", language: "it", topic: "community_media_newsletter_social" },
  { id: "cmm-36", language: "it", topic: "community_media_newsletter_social", crossLingualGroup: "what-is-this-page-about" },
  { id: "cmm-37", language: "it", topic: "community_media_newsletter_social" },
  { id: "cmm-38", language: "it", topic: "community_media_newsletter_social" },
  // --- teachings_philosophy_spiritual_questions — Teachings & spiritual philosophy -
  { id: "tch-01", language: "it", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-02", language: "it", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-03", language: "it", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-04", language: "it", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-05", language: "it", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-06", language: "en", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-07", language: "en", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-08", language: "en", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-09", language: "it", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-10", language: "it", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-11", language: "en", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-12", language: "it", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-13", language: "en", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-14", language: "en", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-15", language: "en", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-16", language: "en", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-17", language: "en", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-18", language: "en", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-19", language: "en", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-20", language: "it", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-21", language: "en", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-22", language: "en", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-23", language: "en", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-24", language: "en", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-25", language: "en", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-26", language: "ru", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-27", language: "ru", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-28", language: "en", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-29", language: "en", topic: "teachings_philosophy_spiritual_questions" },
  { id: "tch-30", language: "en", topic: "teachings_philosophy_spiritual_questions" },
  // --- people_lineage_and_controversies — Teachers/lineage info & controversies -
  { id: "ppl-01", language: "en", topic: "people_lineage_and_controversies" },
  { id: "ppl-02", language: "en", topic: "people_lineage_and_controversies" },
  { id: "ppl-03", language: "en", topic: "people_lineage_and_controversies" },
  { id: "ppl-04", language: "en", topic: "people_lineage_and_controversies" },
  { id: "ppl-05", language: "en", topic: "people_lineage_and_controversies" },
  { id: "ppl-06", language: "en", topic: "people_lineage_and_controversies" },
  { id: "ppl-07", language: "it", topic: "people_lineage_and_controversies" },
  { id: "ppl-08", language: "en", topic: "people_lineage_and_controversies" },
  { id: "ppl-09", language: "en", topic: "people_lineage_and_controversies" },
  { id: "ppl-10", language: "en", topic: "people_lineage_and_controversies" },
  { id: "ppl-11", language: "en", topic: "people_lineage_and_controversies" },
  { id: "ppl-12", language: "en", topic: "people_lineage_and_controversies" },
  { id: "ppl-13", language: "en", topic: "people_lineage_and_controversies" },
  { id: "ppl-14", language: "en", topic: "people_lineage_and_controversies" },
  { id: "ppl-15", language: "it", topic: "people_lineage_and_controversies" },
  { id: "ppl-16", language: "it", topic: "people_lineage_and_controversies" },
  // --- wellness_products_sprays — Wellness products (flower-essence sprays etc.) -
  { id: "wel-01", language: "it", topic: "wellness_products_sprays" },
  { id: "wel-02", language: "it", topic: "wellness_products_sprays" },
  { id: "wel-03", language: "it", topic: "wellness_products_sprays" },
  { id: "wel-04", language: "it", topic: "wellness_products_sprays" },
  { id: "wel-05", language: "it", topic: "wellness_products_sprays" },
  { id: "wel-06", language: "it", topic: "wellness_products_sprays" },
  { id: "wel-07", language: "it", topic: "wellness_products_sprays" },
  { id: "wel-08", language: "it", topic: "wellness_products_sprays" },
  { id: "wel-09", language: "it", topic: "wellness_products_sprays" },
  // --- deliberate outliers ---------------------------------------------------
  { id: "out-01", language: "en", topic: null },
  { id: "out-02", language: "it", topic: null },
  { id: "out-03", language: "it", topic: null },
  { id: "out-04", language: "it", topic: null },
  { id: "out-05", language: "it", topic: null },
  { id: "out-06", language: "it", topic: null },
  { id: "out-07", language: "en", topic: null },
  { id: "out-08", language: "en", topic: null },
  { id: "out-09", language: "en", topic: null },
  { id: "out-10", language: "en", topic: null },
  { id: "out-11", language: "en", topic: null },
  { id: "out-12", language: "en", topic: null },
  { id: "out-13", language: "en", topic: null },
  { id: "out-14", language: "en", topic: null },
  { id: "out-15", language: "en", topic: null },
  { id: "out-16", language: "en", topic: null },
  { id: "out-17", language: "en", topic: null },
  { id: "out-18", language: "it", topic: null },
  { id: "out-19", language: "it", topic: null },
  { id: "out-20", language: "it", topic: null },
  { id: "out-21", language: "it", topic: null },
  { id: "out-22", language: "it", topic: null },
  { id: "out-23", language: "it", topic: null },
  { id: "out-24", language: "it", topic: null },
];

/** Number of hand-assigned topics; the eval clusters at this `k`. */
export const facetQualityTopicCount = new Set(
  facetQualityQuestions.map((entry) => entry.topic).filter((topic): topic is FacetQualityTopic => topic !== null),
).size;
