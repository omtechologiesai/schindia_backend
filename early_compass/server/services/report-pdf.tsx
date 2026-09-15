/**
 * The parent-facing PDF report (A4), rendered with @react-pdf/renderer: real text with the
 * embedded brand font, so it stays sharp when printed and small enough for WhatsApp.
 *
 * Page 1: child and parent details, date and time, the compass chart with its table, focus
 * areas, growth since the last assessment, notes and the "not a diagnostic tool" notice.
 * Then every checklist answer, attainment goals when assessed, and sources & disclaimers.
 *
 * The brand font has no ✓ glyph, so status marks are drawn as vector paths. Each heading is
 * locked together with the first item under it (wrap={false}) so no heading is left alone at
 * the foot of a page; react-pdf's minPresenceAhead is ignored for an element that is the
 * first child of its parent, which is where headings usually are.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Circle, Document, Font, Image, Line, Page, Path, StyleSheet, Svg, Text, View, renderToBuffer } from '@react-pdf/renderer';
import type { ReactNode } from 'react';
import type { ChildDTO, GoalResponseDTO, ReadingSummaryDTO, ResponseItemDTO } from '@shared/api';
import { COLORS, DOMAIN_COLORS, DOMAIN_SOFT, FONT_FAMILY } from '@shared/brand';
import { COMPASS_HEIGHT, COMPASS_WIDTH } from '@shared/compass';
import {
  COMPASS_READING_NOTE,
  customTargetExplainer,
  DATA_NOTICE,
  DISCLAIMER_FOOTER,
  DISCLAIMER_NOT_DIAGNOSTIC,
  onTargetMessage,
  ORG_NAME,
  orgAndCentre,
  PRODUCT_FULL_NAME,
  PRODUCT_NAME,
  SOURCES,
  targetExplainer,
} from '@shared/copy';
import { INTEREST_OPTIONS, type InterestKey } from '@shared/data/activities';
import type { GoalAge } from '@shared/data/goals';
import { BAND_LABEL, DOMAIN_META, DOMAIN_ORDER, type BandKey, type DomainKey } from '@shared/domain';
import { formatAge, formatCalendarDate, formatDate, formatDateTime, formatTime, timeZoneLabel } from '@shared/format';
import { formatPhone } from '@shared/phone';
import { FOCUS_GAP_POINTS, type Commentary, type DomainStat, type DomainStats, type FocusAreaDetail } from '@shared/scoring';
import { config } from '../config';

Font.register({
  family: FONT_FAMILY,
  fonts: [400, 500, 600, 700, 800].map((fontWeight) => ({
    src: path.join(config.assetsDir, 'fonts', `PlusJakartaSans-${fontWeight}.ttf`),
    fontWeight,
  })),
});
// react-pdf hyphenates English words by default; milestone wording reads better unbroken.
Font.registerHyphenationCallback((word) => [word]);

let logoPng: Buffer | null = null;
const logo = () => (logoPng ??= fs.readFileSync(path.join(config.assetsDir, 'brand', 'shichida-india-logo.png')));

export interface ReportModel {
  reference: string;
  assessedAt: string;
  generatedAt: string;
  timeZone: string;
  child: ChildDTO;
  ageMonths: number;
  band: BandKey;
  bandOverridden: boolean;
  checklistVersion: string;
  assessorName: string;
  stats: DomainStats;
  overallPct: number;
  autoTargetPct: number;
  targetPct: number;
  targetIsCustom: boolean;
  focusAreas: FocusAreaDetail[];
  commentary: Commentary;
  /** The previous assessment, when there is one. */
  previous: ReadingSummaryDTO | null;
  /** True when the previous assessment used the same band, so the chart overlays it. */
  previousComparable: boolean;
  responses: ResponseItemDTO[];
  goals: { age: GoalAge; items: GoalResponseDTO[] } | null;
  interests: InterestKey[];
  notes: string;
  chartPng: Buffer;
  contact: { email: string; phone: string; website: string };
}

const s = StyleSheet.create({
  page: {
    fontFamily: FONT_FAMILY,
    fontSize: 9.5,
    lineHeight: 1.4,
    color: COLORS.ink2,
    backgroundColor: COLORS.surface,
    paddingTop: 94,
    paddingBottom: 62,
    paddingHorizontal: 40,
  },
  header: {
    position: 'absolute',
    top: 26,
    left: 40,
    right: 40,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  logo: { width: 30, height: 39 },
  brandName: { fontSize: 11.5, fontWeight: 800, color: COLORS.ink, lineHeight: 1.2 },
  brandSub: { fontSize: 8.5, fontWeight: 600, color: COLORS.muted, lineHeight: 1.2 },
  headerRef: { fontSize: 8.5, fontWeight: 700, color: COLORS.ink, textAlign: 'right', lineHeight: 1.2 },
  headerSub: { fontSize: 8, color: COLORS.muted, textAlign: 'right', lineHeight: 1.3 },
  headerRule: { position: 'absolute', top: 74, left: 40, right: 40, height: 2, backgroundColor: COLORS.sun },
  // Fixed footer pieces are placed from the top of the A4 page (841.89 pt): react-pdf
  // misplaces bottom-anchored fixed elements on the later pages of a long document.
  footerRule: { position: 'absolute', top: 798, left: 40, right: 40, height: 0.5, backgroundColor: COLORS.line },
  footerText: { position: 'absolute', top: 804, left: 40, width: 420, fontSize: 7, color: COLORS.muted, lineHeight: 1.35 },
  footerPage: { position: 'absolute', top: 804, right: 40, width: 80, textAlign: 'right', fontSize: 7.5, fontWeight: 600, color: COLORS.muted },
  eyebrow: { fontSize: 7.5, fontWeight: 700, letterSpacing: 1.1, color: COLORS.muted, textTransform: 'uppercase' },
  h1: { fontSize: 24, fontWeight: 800, color: COLORS.ink, letterSpacing: -0.4, lineHeight: 1.15, marginTop: 3 },
  h1Small: { fontSize: 18, fontWeight: 800, color: COLORS.ink, letterSpacing: -0.3, lineHeight: 1.2, marginTop: 3 },
  h2: { fontSize: 13.5, fontWeight: 800, color: COLORS.ink, letterSpacing: -0.2, lineHeight: 1.25, marginBottom: 4 },
  h3: { fontSize: 10.5, fontWeight: 800, color: COLORS.ink, lineHeight: 1.3 },
  lede: { fontSize: 10, color: COLORS.ink2, marginTop: 3 },
  body: { fontSize: 9.5, color: COLORS.ink2, lineHeight: 1.45 },
  small: { fontSize: 8.5, color: COLORS.muted, lineHeight: 1.4 },
  strong: { fontWeight: 700, color: COLORS.ink },
  section: { marginTop: 18 },
  card: { borderWidth: 0.75, borderColor: COLORS.line, borderRadius: 10, padding: 12 },
  cardTitle: { fontSize: 7.5, fontWeight: 700, letterSpacing: 1, color: COLORS.muted, textTransform: 'uppercase', marginBottom: 5 },
  detailRow: { flexDirection: 'row', paddingVertical: 2.2 },
  detailLabel: { width: 92, fontSize: 8.5, color: COLORS.muted },
  detailValue: { flex: 1, fontSize: 9.5, fontWeight: 600, color: COLORS.ink },
  hero: { fontSize: 34, fontWeight: 800, color: COLORS.ink, letterSpacing: -0.8, lineHeight: 1 },
  heroCaption: { flex: 1, fontSize: 9.5, fontWeight: 600, color: COLORS.ink, marginLeft: 7, marginBottom: 4, lineHeight: 1.25 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4 },
  legendItem: { flexDirection: 'row', alignItems: 'center', marginRight: 10, marginTop: 3 },
  legendText: { fontSize: 7.5, fontWeight: 600, color: COLORS.ink2, marginLeft: 4 },
  domainRow: { marginTop: 7 },
  domainName: { flex: 1, fontSize: 9.5, fontWeight: 700, color: COLORS.ink, marginLeft: 6 },
  domainCount: { width: 52, fontSize: 8.5, color: COLORS.muted, textAlign: 'right' },
  domainPct: { width: 36, fontSize: 10, fontWeight: 800, color: COLORS.ink, textAlign: 'right' },
  meterTrack: { marginTop: 4, height: 5, borderRadius: 3 },
  meterFill: { height: 5, borderRadius: 3 },
  meterTarget: { position: 'absolute', top: -2.5, width: 1.5, height: 10, marginLeft: -0.75, backgroundColor: COLORS.ink },
  callout: { marginTop: 10, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10, backgroundColor: COLORS.sandSoft },
  calloutOk: { marginTop: 6, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10, backgroundColor: COLORS.brandSoft },
  calloutText: { fontSize: 8.5, color: COLORS.ink2, lineHeight: 1.45 },
  focusCard: {
    marginTop: 8,
    borderWidth: 0.75,
    borderColor: COLORS.line,
    borderLeftWidth: 3,
    borderRadius: 6,
    paddingVertical: 9,
    paddingHorizontal: 11,
  },
  miniTitle: { fontSize: 7.5, fontWeight: 700, letterSpacing: 0.8, color: COLORS.muted, textTransform: 'uppercase', marginBottom: 3 },
  bullet: { flexDirection: 'row', marginTop: 2.5 },
  bulletDot: { width: 3.5, height: 3.5, borderRadius: 2, backgroundColor: COLORS.faint, marginTop: 4.5, marginRight: 6 },
  bulletText: { flex: 1, fontSize: 8.8, color: COLORS.ink2, lineHeight: 1.4 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 0.75,
    borderColor: COLORS.lineStrong,
    borderRadius: 10,
    paddingVertical: 2.5,
    paddingHorizontal: 7,
    marginRight: 6,
    marginTop: 6,
  },
  chipText: { fontSize: 8, fontWeight: 600, color: COLORS.ink, marginLeft: 4 },
  notice: {
    flexDirection: 'row',
    borderWidth: 0.75,
    borderColor: COLORS.lineStrong,
    borderRadius: 8,
    padding: 10,
    backgroundColor: COLORS.surface2,
  },
  noticeTitle: { fontSize: 9.5, fontWeight: 800, color: COLORS.ink },
  noticeBody: { fontSize: 8.8, color: COLORS.ink2, lineHeight: 1.45, marginTop: 1 },
  keyRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  keyText: { fontSize: 8.5, color: COLORS.ink2, marginLeft: 5, marginRight: 14 },
  domainHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: 0.75,
    borderBottomColor: COLORS.lineStrong,
  },
  domainHeaderBar: { width: 4, height: 24, borderRadius: 2, marginRight: 8 },
  domainHeaderStat: { fontSize: 8.5, fontWeight: 700, color: COLORS.ink, textAlign: 'right' },
  answerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 3.6,
    paddingHorizontal: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: COLORS.line,
  },
  answerRowAlt: { backgroundColor: COLORS.surface2 },
  answerNo: { width: 17, fontSize: 7.5, color: COLORS.muted, marginTop: 1 },
  answerIcon: { marginTop: 1, marginRight: 7 },
  answerText: { flex: 1, fontSize: 8.8, color: COLORS.ink, lineHeight: 1.35 },
  answerTextOff: { color: COLORS.ink2 },
  answerStatus: { width: 50, fontSize: 7.5, fontWeight: 600, color: COLORS.muted, textAlign: 'right', marginTop: 1 },
  answerStatusOn: { color: COLORS.brandInk, fontWeight: 700 },
  goalCategory: { fontSize: 9.5, fontWeight: 800, color: COLORS.ink, marginTop: 10, marginBottom: 2 },
  source: { marginTop: 7 },
  sourceTitle: { fontSize: 9, fontWeight: 700, color: COLORS.ink },
  sourceBody: { fontSize: 8.5, color: COLORS.ink2, lineHeight: 1.45 },
});

/* ---------------------------------------------------------------- atoms */

function Dot({ color, size = 8 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size}>
      <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={color} />
    </Svg>
  );
}

function StatusIcon({ on }: { on: boolean }) {
  return (
    <Svg width={10} height={10} style={s.answerIcon}>
      {on ? (
        <>
          <Circle cx={5} cy={5} r={5} fill={COLORS.brand} />
          <Path d="M2.7 5.2 L4.3 6.8 L7.4 3.5" stroke={COLORS.surface} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </>
      ) : (
        <Circle cx={5} cy={5} r={4.3} stroke={COLORS.faint} strokeWidth={1} fill="none" />
      )}
    </Svg>
  );
}

function InfoIcon() {
  return (
    <Svg width={13} height={13}>
      <Circle cx={6.5} cy={6.5} r={5.8} stroke={COLORS.ink} strokeWidth={1.1} fill="none" />
      <Line x1={6.5} y1={5.8} x2={6.5} y2={9.4} stroke={COLORS.ink} strokeWidth={1.3} strokeLinecap="round" />
      <Circle cx={6.5} cy={3.9} r={0.8} fill={COLORS.ink} />
    </Svg>
  );
}

function LegendKey({ kind }: { kind: 'current' | 'target' | 'previous' }) {
  const stroke = kind === 'current' ? COLORS.brand : kind === 'target' ? COLORS.muted : COLORS.faint;
  return (
    <Svg width={16} height={6}>
      <Line
        x1={1}
        y1={3}
        x2={15}
        y2={3}
        stroke={stroke}
        strokeWidth={kind === 'target' ? 1.4 : 2.4}
        strokeLinecap={kind === 'target' ? 'butt' : 'round'}
        strokeDasharray={kind === 'target' ? '3,2.5' : undefined}
      />
    </Svg>
  );
}

function Bullet({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <View style={s.bullet}>
      <View style={s.bulletDot} />
      <Text style={s.bulletText}>
        {title ? <Text style={s.strong}>{title}. </Text> : null}
        {children}
      </Text>
    </View>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <View style={s.notice} wrap={false}>
      <InfoIcon />
      <View style={{ flex: 1, marginLeft: 8 }}>
        <Text style={s.noticeTitle}>{title}</Text>
        <Text style={s.noticeBody}>{body}</Text>
      </View>
    </View>
  );
}

function Meter({ domain, pct, target }: { domain: DomainKey; pct: number; target: number }) {
  const clamp = (n: number) => Math.max(0, Math.min(100, n));
  return (
    <View style={[s.meterTrack, { backgroundColor: DOMAIN_SOFT[domain] }]}>
      <View style={[s.meterFill, { width: `${clamp(pct)}%`, backgroundColor: DOMAIN_COLORS[domain] }]} />
      <View style={[s.meterTarget, { left: `${clamp(target)}%` }]} />
    </View>
  );
}

function AnswerRow(props: { index: number; text: string; on: boolean; onLabel: string; offLabel: string }) {
  return (
    <View style={props.index % 2 === 1 ? [s.answerRow, s.answerRowAlt] : s.answerRow} wrap={false}>
      <Text style={s.answerNo}>{props.index + 1}</Text>
      <StatusIcon on={props.on} />
      <Text style={props.on ? s.answerText : [s.answerText, s.answerTextOff]}>{props.text}</Text>
      <Text style={props.on ? [s.answerStatus, s.answerStatusOn] : s.answerStatus}>{props.on ? props.onLabel : props.offLabel}</Text>
    </View>
  );
}

/* ------------------------------------------------------- page furniture */

function Header({ model, childName }: { model: ReportModel; childName: string }) {
  return (
    <>
      <View style={s.header} fixed>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Image src={{ data: logo(), format: 'png' }} style={s.logo} />
          <View style={{ marginLeft: 9 }}>
            <Text style={s.brandName}>{ORG_NAME}</Text>
            <Text style={s.brandSub}>{PRODUCT_NAME} report</Text>
          </View>
        </View>
        <View>
          <Text style={s.headerRef}>{model.reference}</Text>
          <Text style={s.headerSub}>
            {childName} · {formatDate(model.assessedAt, model.timeZone)}
          </Text>
        </View>
      </View>
      <View style={s.headerRule} fixed />
    </>
  );
}

function Footer() {
  return (
    <>
      <View style={s.footerRule} fixed />
      <Text style={s.footerText} fixed>
        {DISCLAIMER_FOOTER}
      </Text>
      <Text style={s.footerPage} fixed render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
    </>
  );
}

/* --------------------------------------------------------------- page 1 */

function DetailsCard({ model, childName }: { model: ReportModel; childName: string }) {
  const c = model.child;
  const tz = model.timeZone;
  const left: [string, string][] = [
    ['Child', childName],
    ['Date of birth', formatCalendarDate(c.dateOfBirth, 'long')],
    ['Age at assessment', formatAge(model.ageMonths, 'long')],
    ['Gender', c.gender ?? 'Not recorded'],
    ['Centre', c.centre || 'Not recorded'],
  ];
  const right: [string, string][] = [
    ['Parent / guardian', `${c.parent.name} (${c.parent.relation})`],
    ['Mobile', formatPhone(c.parent.phone)],
    ['Email', c.parent.email || 'Not recorded'],
    ['Assessed on', formatDateTime(model.assessedAt, tz)],
    ['Assessed by', model.assessorName],
  ];
  const column = (title: string, rows: [string, string][]) => (
    <View style={{ flex: 1 }}>
      <Text style={s.cardTitle}>{title}</Text>
      {rows.map(([label, value]) => (
        <View key={label} style={s.detailRow}>
          <Text style={s.detailLabel}>{label}</Text>
          <Text style={s.detailValue}>{value}</Text>
        </View>
      ))}
    </View>
  );
  return (
    <View style={[s.card, { flexDirection: 'row', marginTop: 12 }]} wrap={false}>
      {column('Child details', left)}
      <View style={{ width: 0.75, backgroundColor: COLORS.line, marginHorizontal: 12 }} />
      {column('Parent & assessment', right)}
    </View>
  );
}

function Results({ model }: { model: ReportModel }) {
  const chartWidth = 232;
  const targetText = model.targetIsCustom
    ? customTargetExplainer(model.targetPct, model.autoTargetPct)
    : targetExplainer(formatAge(model.ageMonths, 'long'), BAND_LABEL[model.band], model.targetPct);
  return (
    <View style={[s.card, { flexDirection: 'row', marginTop: 10 }]} wrap={false}>
      <View style={{ width: chartWidth }}>
        <Image
          src={{ data: model.chartPng, format: 'png' }}
          style={{ width: chartWidth, height: (chartWidth * COMPASS_HEIGHT) / COMPASS_WIDTH }}
        />
        <View style={s.legend}>
          <View style={s.legendItem}>
            <LegendKey kind="current" />
            <Text style={s.legendText}>This assessment</Text>
          </View>
          <View style={s.legendItem}>
            <LegendKey kind="target" />
            <Text style={s.legendText}>Target for age ({model.targetPct}%)</Text>
          </View>
          {model.previous && model.previousComparable ? (
            <View style={s.legendItem}>
              <LegendKey kind="previous" />
              <Text style={s.legendText}>Previous ({formatDate(model.previous.assessedAt, model.timeZone)})</Text>
            </View>
          ) : null}
        </View>
      </View>
      <View style={{ flex: 1, marginLeft: 16 }}>
        <Text style={s.eyebrow}>Compass reading</Text>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', marginTop: 4 }}>
          <Text style={s.hero}>{Math.round(model.overallPct)}%</Text>
          <Text style={s.heroCaption}>of {BAND_LABEL[model.band]} milestones observed</Text>
        </View>
        <Text style={[s.small, { marginTop: 5 }]}>{targetText}</Text>
        <View style={{ marginTop: 4 }}>
          {DOMAIN_ORDER.map((domain) => (
            <DomainRow key={domain} domain={domain} stat={model.stats[domain]} target={model.targetPct} />
          ))}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
          <View style={{ width: 1.5, height: 9, backgroundColor: COLORS.ink }} />
          <Text style={[s.small, { marginLeft: 5 }]}>marks the {model.targetPct}% target on each bar</Text>
        </View>
      </View>
    </View>
  );
}

function DomainRow({ domain, stat, target }: { domain: DomainKey; stat: DomainStat; target: number }) {
  return (
    <View style={s.domainRow}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Dot color={DOMAIN_COLORS[domain]} />
        <Text style={s.domainName}>{DOMAIN_META[domain].name}</Text>
        <Text style={s.domainCount}>
          {stat.done} of {stat.total}
        </Text>
        <Text style={s.domainPct}>{Math.round(stat.pct)}%</Text>
      </View>
      <Meter domain={domain} pct={stat.pct} target={target} />
    </View>
  );
}

function FocusCard({ area }: { area: FocusAreaDetail }) {
  return (
    <View style={[s.focusCard, { borderLeftColor: DOMAIN_COLORS[area.domain] }]} wrap={false}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <Text style={s.h3}>{DOMAIN_META[area.domain].name}</Text>
        <Text style={s.small}>
          {Math.round(area.pct)}% observed · {Math.round(area.gap)} pts below target
        </Text>
      </View>
      <View style={{ flexDirection: 'row', marginTop: 5 }}>
        <View style={{ flex: 1, paddingRight: 12 }}>
          <Text style={s.miniTitle}>Try these activities</Text>
          {area.activities.map((activity) => (
            <Bullet key={activity.text}>{activity.text}</Bullet>
          ))}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.miniTitle}>Milestones to aim for next</Text>
          {area.nextMilestones.length ? (
            area.nextMilestones.map((text) => <Bullet key={text}>{text}</Bullet>)
          ) : (
            <Text style={s.small}>Every milestone in this domain was observed.</Text>
          )}
        </View>
      </View>
    </View>
  );
}

function FocusAreas({ model }: { model: ReportModel }) {
  const interests = model.interests
    .map((key) => INTEREST_OPTIONS.find((option) => option.key === key)?.label)
    .filter((label): label is string => Boolean(label));
  const [first, ...rest] = model.focusAreas;
  return (
    <View style={s.section}>
      <View wrap={false}>
        <Text style={s.h2}>Focus areas & suggested activities</Text>
        {first ? (
          <>
            <Text style={s.body}>
              Domains more than {FOCUS_GAP_POINTS} points below the {model.targetPct}% target, with play ideas to try at home
              {interests.length ? ` (matched to interests: ${interests.join(', ')})` : ''}.
            </Text>
            <FocusCard area={first} />
          </>
        ) : (
          <View style={s.calloutOk}>
            <Text style={s.calloutText}>{onTargetMessage(model.targetPct)}</Text>
          </View>
        )}
      </View>
      {rest.map((area) => (
        <FocusCard key={area.domain} area={area} />
      ))}
    </View>
  );
}

function Growth({ model }: { model: ReportModel }) {
  const { narrative, deltas } = model.commentary;
  return (
    <View style={s.section} wrap={false}>
      <Text style={s.h2}>Growth since the last assessment</Text>
      <Text style={s.body}>{narrative}</Text>
      {deltas ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          {deltas.map(({ domain, delta }) => {
            const text = delta > 0.5 ? `+${Math.round(delta)}` : delta < -0.5 ? `-${Math.round(Math.abs(delta))}` : '±0';
            return (
              <View key={domain} style={s.chip}>
                <Dot color={DOMAIN_COLORS[domain]} size={6} />
                <Text style={s.chipText}>
                  {DOMAIN_META[domain].short} {text} pts
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function Summary({ model, childName }: { model: ReportModel; childName: string }) {
  const tz = model.timeZone;
  return (
    <View>
      <Text style={s.eyebrow}>Developmental assessment report</Text>
      <Text style={s.h1}>{childName}</Text>
      <Text style={s.lede}>
        Assessed on {formatDate(model.assessedAt, tz, 'long')} at {formatTime(model.assessedAt, tz)} {timeZoneLabel(tz)} ·{' '}
        {BAND_LABEL[model.band]} checklist
      </Text>
      <DetailsCard model={model} childName={childName} />
      <Results model={model} />
      <View style={s.callout} wrap={false}>
        <Text style={s.calloutText}>{COMPASS_READING_NOTE}</Text>
      </View>
      <FocusAreas model={model} />
      {model.previous ? <Growth model={model} /> : null}
      {model.notes ? (
        // Notes are capped at 2,000 characters, so they always fit on one page with their heading.
        <View style={s.section} wrap={false}>
          <Text style={s.h2}>Assessor’s notes</Text>
          <Text style={s.body}>{model.notes}</Text>
        </View>
      ) : null}
      <View style={s.section}>
        <Notice title={DISCLAIMER_NOT_DIAGNOSTIC.title} body={DISCLAIMER_NOT_DIAGNOSTIC.body} />
      </View>
    </View>
  );
}

/* ---------------------------------------------------------- the answers */

function Responses({ model }: { model: ReportModel }) {
  const observed = model.responses.filter((r) => r.observed).length;
  const row = (item: ResponseItemDTO, index: number) => (
    <AnswerRow key={item.id} index={index} text={item.text} on={item.observed} onLabel="Observed" offLabel="Not yet" />
  );
  return (
    <View break>
      <Text style={s.eyebrow}>Answers recorded</Text>
      <Text style={s.h1Small}>Milestone checklist responses</Text>
      <Text style={[s.body, { marginTop: 3 }]}>
        {BAND_LABEL[model.band]} checklist: {observed} of {model.responses.length} milestones observed during the assessment on{' '}
        {formatDate(model.assessedAt, model.timeZone, 'long')}.
        {model.bandOverridden ? ' The band was selected manually for this assessment.' : ''}
      </Text>
      <View style={s.keyRow}>
        <StatusIcon on />
        <Text style={s.keyText}>Observed</Text>
        <StatusIcon on={false} />
        <Text style={s.keyText}>Not yet observed</Text>
      </View>
      {DOMAIN_ORDER.map((domain) => {
        const items = model.responses.filter((r) => r.domain === domain);
        const stat = model.stats[domain];
        return (
          <View key={domain} style={{ marginTop: 14 }}>
            <View wrap={false}>
              <View style={s.domainHeader}>
                <View style={[s.domainHeaderBar, { backgroundColor: DOMAIN_COLORS[domain] }]} />
                <View style={{ flex: 1 }}>
                  <Text style={s.h3}>{DOMAIN_META[domain].name}</Text>
                  <Text style={s.small}>{DOMAIN_META[domain].blurb}</Text>
                </View>
                <Text style={s.domainHeaderStat}>
                  {stat.done} of {stat.total} observed · {Math.round(stat.pct)}%
                </Text>
              </View>
              {items[0] ? row(items[0], 0) : null}
            </View>
            {items.slice(1).map((item, i) => row(item, i + 1))}
          </View>
        );
      })}
    </View>
  );
}

function Goals({ goals }: { goals: NonNullable<ReportModel['goals']> }) {
  const categories = new Map<string, GoalResponseDTO[]>();
  for (const item of goals.items) categories.set(item.category, [...(categories.get(item.category) ?? []), item]);
  const achieved = goals.items.filter((item) => item.achieved).length;
  const row = (item: GoalResponseDTO, index: number) => (
    <AnswerRow key={item.id} index={index} text={item.text} on={item.achieved} onLabel="Achieved" offLabel="Not yet" />
  );
  return (
    <View style={{ marginTop: 22 }}>
      {[...categories.entries()].map(([category, items], position) => (
        <View key={category}>
          <View wrap={false}>
            {position === 0 ? (
              <>
                <Text style={s.h2}>Attainment goals · age {goals.age}</Text>
                <Text style={s.body}>
                  Broader curriculum-style targets from the Shichida goals-by-age framework, recorded alongside the checklist. They do
                  not change the compass reading. {achieved} of {goals.items.length} achieved.
                </Text>
              </>
            ) : null}
            <Text style={s.goalCategory}>{category}</Text>
            {items[0] ? row(items[0], 0) : null}
          </View>
          {items.slice(1).map((item, i) => row(item, i + 1))}
        </View>
      ))}
    </View>
  );
}

/* ------------------------------------------------ sources & disclaimers */

function About({ model }: { model: ReportModel }) {
  const contact = [model.contact.phone, model.contact.email, model.contact.website].filter(Boolean);
  return (
    <View break>
      <Text style={s.eyebrow}>About this report</Text>
      <Text style={s.h1Small}>How to read this report</Text>
      <View style={{ marginTop: 4 }}>
        <Bullet title="Compass reading">
          The share of milestones in the {BAND_LABEL[model.band]} checklist that were observed, overall and for each of the four
          Shichida domains: Physical (N), Sensory (E), Language (S) and Social (W).
        </Bullet>
        <Bullet title="Target for age">
          Where a child of this age typically is, assuming a steady pace through the band.{' '}
          {model.targetIsCustom
            ? customTargetExplainer(model.targetPct, model.autoTargetPct)
            : `For this assessment it is ${model.targetPct}%.`}
        </Bullet>
        <Bullet title="Focus areas">
          Domains more than {FOCUS_GAP_POINTS} points below the target, with play ideas to try at home. A smaller reading points to
          where to focus play next, not a deficit.
        </Bullet>
      </View>

      <View style={s.section}>
        <Text style={s.h2}>Sources & methodology</Text>
        {SOURCES.map((source) => (
          <View key={source.title} style={s.source} wrap={false}>
            <Text style={s.sourceTitle}>{source.title}</Text>
            <Text style={s.sourceBody}>
              {source.body}
              {source.ref ? ` ${source.ref}` : ''}
            </Text>
          </View>
        ))}
      </View>

      <View style={s.section}>
        <Notice title={DISCLAIMER_NOT_DIAGNOSTIC.title} body={DISCLAIMER_NOT_DIAGNOSTIC.body} />
      </View>

      <View style={s.section} wrap={false}>
        <Text style={s.h3}>Your data</Text>
        <Text style={s.body}>{DATA_NOTICE}</Text>
        <Text style={[s.body, { marginTop: 6 }]}>
          Questions about this report? Speak to {model.child.centre ? orgAndCentre(model.child.centre) : `your ${ORG_NAME} centre`}
          {contact.length ? ` or contact ${contact.join(' · ')}` : ''}.
        </Text>
        <Text style={[s.small, { marginTop: 10 }]}>
          Report {model.reference} · checklist {model.checklistVersion} · generated {formatDateTime(model.generatedAt, model.timeZone)}
        </Text>
      </View>
    </View>
  );
}

function ReportDocument({ model }: { model: ReportModel }) {
  const childName = `${model.child.firstName} ${model.child.lastName}`;
  return (
    <Document
      title={`${PRODUCT_FULL_NAME} report · ${childName} · ${model.reference}`}
      author={ORG_NAME}
      subject="Developmental assessment report"
      creator={PRODUCT_FULL_NAME}
      producer={PRODUCT_FULL_NAME}
    >
      <Page size="A4" style={s.page}>
        <Header model={model} childName={childName} />
        <Footer />
        <Summary model={model} childName={childName} />
        <Responses model={model} />
        {model.goals ? <Goals goals={model.goals} /> : null}
        <About model={model} />
      </Page>
    </Document>
  );
}

export function renderReportPdf(model: ReportModel): Promise<Buffer> {
  return renderToBuffer(<ReportDocument model={model} />);
}
