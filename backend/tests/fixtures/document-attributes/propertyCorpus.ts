/**
 * An invented location catalogue: three properties, each a leading attribute
 * block followed by a description long enough to span several chunks at the
 * default chunk size. Every name, place and detail is made up.
 */
export interface PropertyFixture {
  readonly title: string;
  readonly region: string;
  readonly markdown: string;
  /** A phrase that appears only in the document's last paragraph. */
  readonly deepPhrase: string;
}

const property = (input: {
  name: string;
  id: string;
  region: string;
  type: string;
  style: string;
  paragraphs: readonly string[];
  deepPhrase: string;
}): PropertyFixture => ({
  title: `${input.id} ${input.name}`,
  region: input.region,
  deepPhrase: input.deepPhrase,
  markdown: [
    `# ${input.name}`,
    "",
    `- **Property id:** ${input.id}`,
    `- **Region:** ${input.region}`,
    `- **Type:** ${input.type}`,
    `- **Architectural style:** ${input.style}`,
    "- **Film crew capacity:** up to 30 crew; base camp for 4 vehicles",
    "",
    "## Description",
    "",
    ...input.paragraphs.flatMap((paragraph) => [paragraph, ""]),
  ].join("\n").trim(),
});

export const propertyCorpus: readonly PropertyFixture[] = [
  property({
    name: "Podere Selvalunga",
    id: "fixture-p1",
    region: "Umbria",
    type: "Farmhouse",
    style: "Rural stone",
    deepPhrase: "lavender drying loft",
    paragraphs: [
      "Podere Selvalunga is a stone farmhouse on a low ridge above a valley of olive groves, reached by a white gravel track lined with cypresses. The main house has thick walls, small deep windows and a terracotta roof that turns gold in the evening light.",
      "Inside, the ground floor keeps its original barrel vaults, a long kitchen with a stone sink and a hearth wide enough to stand in. Upstairs, five bedrooms open off a single corridor, each with chestnut beams and tiled floors worn smooth by a century of use.",
      "Productions use the threshing floor for harvest scenes and long dinner tables, and the vaulted cellar reads well as a tavern or a hiding place. The surrounding fields are kept unmown until late spring, which gives wide shots a soft green foreground without any modern fencing in frame.",
      "Light is best in the late afternoon, when the sun drops behind the hill and the stone walls warm to amber. The track is passable for vans in dry weather; after rain, crews park at the chapel below and walk the last three hundred metres up through the vines.",
      "Behind the barn there is a lavender drying loft with open timber sides, a favourite for close dialogue and period interiors. Morning light falls through the slats in narrow bands, and the scent stays in the wood all year.",
    ],
  }),
  property({
    name: "Villa Marisol",
    id: "fixture-p2",
    region: "Campania",
    type: "Villa",
    style: "Modernist",
    deepPhrase: "salt-bleached boathouse",
    paragraphs: [
      "Villa Marisol stands on a cliff above a small bay, a white house of flat roofs and long horizontal lines built around a central courtyard. Its terraces step down the rock towards the water, and the lowest one holds a rectangular pool cut into the stone.",
      "The living room is glazed on three sides and opens fully onto the upper terrace, so interior and exterior can play as one continuous set. Terrazzo floors, built-in teak cabinets and low concrete benches give it a convincing period feel for stories set in the 1960s.",
      "Commercial crews favour the pool terrace for fashion stills and drink advertisements, while feature films use the courtyard for quiet two-person scenes. The access road is narrow, so larger trucks unload at a lay-by and shuttle equipment in smaller vans.",
      "Light is best from mid-afternoon, when the sun moves round to the sea side and the white walls stop flaring. Mornings are calm and suit drone work over the bay, while the wind usually rises after four and can make sound recording on the lower terrace difficult.",
      "At the foot of the stairs a salt-bleached boathouse sits on the rocks, with a slipway and a wooden door painted pale blue. It works as a fisherman's store, a smugglers' hideout or a quiet place for a confession scene at dusk.",
    ],
  }),
  property({
    name: "Ex Lanificio Orsetti",
    id: "fixture-p3",
    region: "Piedmont",
    type: "Industrial loft",
    style: "Early twentieth-century industrial",
    deepPhrase: "copper dye vats",
    paragraphs: [
      "Ex Lanificio Orsetti is a former wool mill on the bank of a fast river, a long red brick building with tall arched windows and a saw-tooth roof of glass. The machinery was removed decades ago, leaving open halls with cast-iron columns and worn wooden floors.",
      "The main hall is more than eighty metres long and can be blacked out completely, which makes it a practical studio for night interiors and controlled lighting set-ups. A mezzanine runs along one side and gives a high angle over the whole floor.",
      "Music videos and fashion campaigns use the raw brick and the rhythm of the columns, and dramas use the offices on the upper floor as a period newsroom. Power is available on site for most lighting packages, and a goods lift reaches every level.",
      "The river is loud in spring, so dialogue scenes are usually recorded in the inner offices, where the walls are thicker and the windows face the courtyard. Parking for trucks is on the old loading yard, and there is room for catering tents under the plane trees.",
      "In the dye house at the back, a row of copper dye vats still stands on a tiled platform, green with age. The room has a single skylight and a drain channel across the floor, and it reads as a laboratory, a workshop or a prison kitchen.",
    ],
  }),
];
