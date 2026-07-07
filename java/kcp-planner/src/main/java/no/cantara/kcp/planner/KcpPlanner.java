package no.cantara.kcp.planner;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

import no.cantara.kcp.planner.diff.BudgetShift;
import no.cantara.kcp.planner.diff.PlanDiff;
import no.cantara.kcp.planner.diff.ReasonChange;
import no.cantara.kcp.planner.diff.ScoreChange;
import no.cantara.kcp.planner.diff.UnitMove;
import no.cantara.kcp.planner.diff.UnitPresence;
import no.cantara.kcp.planner.model.Manifest;
import no.cantara.kcp.planner.model.ManifestRef;
import no.cantara.kcp.planner.model.Payment;
import no.cantara.kcp.planner.model.PaymentMethod;
import no.cantara.kcp.planner.model.RateLimitTier;
import no.cantara.kcp.planner.model.RateLimits;
import no.cantara.kcp.planner.model.RequestCount;
import no.cantara.kcp.planner.model.Temporal;
import no.cantara.kcp.planner.model.Unit;
import no.cantara.kcp.planner.trace.DecisionTrace;
import no.cantara.kcp.planner.trace.GateName;
import no.cantara.kcp.planner.trace.GateVerdict;
import no.cantara.kcp.planner.trace.UnitTrace;

/**
 * The deterministic KCP planner — the LLM-free heart of the agent, ported from
 * {@code src/planner.ts}.
 *
 * <p>Given a task and a {@link Manifest}, {@link #plan} produces an inspectable
 * load plan: which units to load and in what order, which to skip and exactly why,
 * how sub-manifests are selected across the federation, and what the whole thing
 * costs. No model is involved — the plan is an auditable artifact you can read
 * before any content is loaded or any request is paid for.</p>
 *
 * <p>The method is pure: no I/O, no clock beyond the optional {@code asOf} default,
 * deterministic output for a given {@code (manifest, task, options)} triple. Two
 * independent implementations that reproduce every conformance vector validate the
 * spec, not just the code.</p>
 */
public final class KcpPlanner {

    private KcpPlanner() {
    }

    private static final Set<String> STOPWORDS = Set.of(
            "the", "a", "an", "is", "are", "was", "were", "do", "does", "how", "what", "why", "when",
            "where", "which", "who", "to", "of", "in", "on", "for", "and", "or", "i", "we", "you", "it",
            "this", "that", "with", "my", "our", "can", "should", "will", "be", "get", "getting");

    /** Round away float noise in currency arithmetic — matches {@code Number(n.toFixed(6))}. */
    private static final BigDecimal EPSILON = new BigDecimal("1e-9");

    private static final java.util.regex.Pattern NON_WORD =
            java.util.regex.Pattern.compile("[^\\p{L}\\p{N}]+", java.util.regex.Pattern.UNICODE_CHARACTER_CLASS);

    /**
     * Tokenize a task into matchable terms — lowercased, split on any non-letter/
     * digit boundary (Unicode-aware), with terms of two characters or fewer and
     * stopwords dropped. Shared with the validator so the lint sees exactly what
     * the planner sees.
     *
     * @param task the task text
     * @return the search terms, in order, duplicates preserved
     */
    public static List<String> terms(String task) {
        List<String> out = new ArrayList<>();
        for (String t : NON_WORD.split(task.toLowerCase(Locale.ROOT))) {
            if (t.length() > 2 && !STOPWORDS.contains(t)) {
                out.add(t);
            }
        }
        return out;
    }

    /** The score and per-signal reasons for one unit. */
    private record ScoreResult(int score, List<String> reasons) {
    }

    /**
     * Score a unit against the task terms — intent (+3), trigger (+4, bidirectional
     * substring), id/path (+2). Mirrors {@code scoreUnit} in {@code src/planner.ts}.
     *
     * @param unit      the unit to score
     * @param taskTerms the task terms from {@link #terms}
     * @return the score and the per-signal reasons
     */
    static ScoreResult scoreUnit(Unit unit, List<String> taskTerms) {
        String intent = unit.intent().toLowerCase(Locale.ROOT);
        List<String> triggers = new ArrayList<>();
        for (String tr : unit.triggers()) {
            triggers.add(tr.toLowerCase(Locale.ROOT));
        }
        String idPath = (unit.id() + " " + unit.path()).toLowerCase(Locale.ROOT);

        int intentHits = 0;
        int triggerHits = 0;
        int idHits = 0;
        for (String t : taskTerms) {
            if (intent.contains(t)) {
                intentHits++;
            }
            boolean triggerHit = false;
            for (String tr : triggers) {
                if (tr.contains(t) || t.contains(tr)) {
                    triggerHit = true;
                    break;
                }
            }
            if (triggerHit) {
                triggerHits++;
            }
            if (idPath.contains(t)) {
                idHits++;
            }
        }
        int score = 0;
        List<String> reasons = new ArrayList<>();
        if (intentHits > 0) {
            score += intentHits * 3;
            reasons.add("intent matches " + intentHits + " term(s)");
        }
        if (triggerHits > 0) {
            score += triggerHits * 4;
            reasons.add("triggers match " + triggerHits + " term(s)");
        }
        if (idHits > 0) {
            score += idHits * 2;
            reasons.add("id/path matches " + idHits + " term(s)");
        }
        return new ScoreResult(score, reasons);
    }

    private enum TemporalStatus {
        ACTIVE, FUTURE, EXPIRED
    }

    static TemporalStatus temporalStatus(Unit unit, String asOf) {
        Temporal t = unit.temporal();
        if (t == null) {
            return TemporalStatus.ACTIVE;
        }
        if (t.validFrom() != null && t.validFrom().compareTo(asOf) > 0) {
            return TemporalStatus.FUTURE;
        }
        if (t.validUntil() != null && t.validUntil().compareTo(asOf) < 0) {
            return TemporalStatus.EXPIRED;
        }
        return TemporalStatus.ACTIVE;
    }

    /**
     * Supersession precedence (spec §4.22): a unit whose declared successor is
     * itself selectable at {@code asOf} should not be selected. Returns the
     * successor id when it is active and audience-eligible, else {@code null}.
     */
    static String selectableSuccessor(Unit unit, Manifest manifest, String asOf, String role) {
        Temporal t = unit.temporal();
        if (t == null || t.supersededBy() == null) {
            return null;
        }
        String succId = t.supersededBy();
        Unit succ = null;
        for (Unit u : manifest.units()) {
            if (u.id().equals(succId)) {
                succ = u;
                break;
            }
        }
        if (succ == null || Boolean.TRUE.equals(succ.deprecated())) {
            return null;
        }
        if (temporalStatus(succ, asOf) != TemporalStatus.ACTIVE) {
            return null;
        }
        if (!succ.audience().isEmpty() && !succ.audience().contains(role)) {
            return null;
        }
        return succId;
    }

    /** Choose the first payment method the agent supports, from a unit/root payment block. */
    static PaymentPlan planPayment(Payment payment, AgentCapabilities caps) {
        List<PaymentMethod> methods = payment != null ? payment.methods() : null;
        if (methods == null || methods.isEmpty()) {
            return new PaymentPlan("free", null, null, null, true);
        }
        for (PaymentMethod m : methods) {
            if (!caps.paymentMethods().contains(m.type())) {
                continue;
            }
            if ("free".equals(m.type())) {
                return new PaymentPlan("free", null, null, null, true);
            }
            if ("x402".equals(m.type())) {
                BigDecimal price = parseDecimal(m.pricePerRequest());
                return new PaymentPlan(
                        "x402",
                        m.pricePerRequest() + " " + m.currency() + "/request",
                        price,
                        m.currency(),
                        true);
            }
            return new PaymentPlan(m.type(), null, null, null, true);
        }
        List<String> need = new ArrayList<>();
        for (PaymentMethod m : methods) {
            if (!"free".equals(m.type())) {
                need.add(m.type());
            }
        }
        return new PaymentPlan("needs " + String.join(" or ", need), null, null, null, false);
    }

    /** The token cost the planner weighs for a unit, from metadata (audit-before-action). */
    private record TokenInfo(Long tokens, boolean approximate, boolean measured) {
    }

    private static TokenInfo unitTokens(Unit unit) {
        if (unit.sizeTokens() != null) {
            return new TokenInfo(unit.sizeTokens(), false, true);
        }
        if (unit.bytes() != null) {
            return new TokenInfo((unit.bytes() + 3) / 4, true, true); // ceil(bytes / 4)
        }
        return new TokenInfo(null, false, false);
    }

    /**
     * Produce a deterministic, inspectable plan. Pure — no I/O, no model.
     *
     * @param manifest the parsed manifest
     * @param task     the task to plan for
     * @param options  the planning options
     * @return the load plan
     */
    public static AgentPlan plan(Manifest manifest, String task, PlanOptions options) {
        AgentCapabilities caps = options.capabilities();
        String asOf = options.asOf() != null ? options.asOf() : todayUtc();
        int maxUnits = options.maxUnits();
        List<String> warnings = new ArrayList<>();
        List<String> taskTerms = terms(task);
        if (taskTerms.isEmpty()) {
            warnings.add("task produced no search terms after stopword removal");
        }

        boolean requiresAttestation = manifest.trust() != null
                && manifest.trust().agentRequirements() != null
                && Boolean.TRUE.equals(manifest.trust().agentRequirements().requireAttestation());
        List<String> trustedProviders = requiresAttestation && manifest.trust().agentRequirements().trustedProviders() != null
                ? manifest.trust().agentRequirements().trustedProviders()
                : List.of();
        boolean agentCanAttest = !requiresAttestation
                || (caps.attestationProvider() != null && trustedProviders.contains(caps.attestationProvider()));

        List<PlannedUnit> selected = new ArrayList<>();
        List<SkippedUnit> skipped = new ArrayList<>();

        for (Unit unit : manifest.units()) {
            // 1. audience
            if (!unit.audience().isEmpty() && !unit.audience().contains(caps.role())) {
                skipped.add(new SkippedUnit(unit.id(),
                        "audience " + jsonArr(unit.audience()) + " excludes role '" + caps.role() + "'"));
                continue;
            }
            // 2. not_for
            String nf = firstNotFor(unit.notFor(), taskTerms);
            if (nf != null) {
                skipped.add(new SkippedUnit(unit.id(), "not_for declares it does not serve '" + nf + "'"));
                continue;
            }
            // 3. temporal
            TemporalStatus ts = temporalStatus(unit, asOf);
            if (ts == TemporalStatus.FUTURE) {
                skipped.add(new SkippedUnit(unit.id(),
                        "not active until " + orEmpty(unit.temporal() != null ? unit.temporal().validFrom() : null)));
                continue;
            }
            if (ts == TemporalStatus.EXPIRED) {
                String succ = unit.temporal() != null && unit.temporal().supersededBy() != null
                        ? " (superseded by " + unit.temporal().supersededBy() + ")"
                        : "";
                skipped.add(new SkippedUnit(unit.id(),
                        "expired " + orEmpty(unit.temporal() != null ? unit.temporal().validUntil() : null) + succ));
                continue;
            }
            // 4. deprecated
            if (Boolean.TRUE.equals(unit.deprecated())) {
                skipped.add(new SkippedUnit(unit.id(), "deprecated"));
                continue;
            }
            // 5. supersession precedence
            String successor = selectableSuccessor(unit, manifest, asOf, caps.role());
            if (successor != null) {
                skipped.add(new SkippedUnit(unit.id(), "superseded by " + successor + " (successor active)"));
                continue;
            }
            // 6. relevance
            ScoreResult sr = scoreUnit(unit, taskTerms);
            if (sr.score() == 0) {
                skipped.add(new SkippedUnit(unit.id(), "no task-relevance match"));
                continue;
            }
            List<String> reasons = new ArrayList<>(sr.reasons());
            // 7. attestation
            boolean unitRequiresAttestation = requiresAttestation && "restricted".equals(unit.access());
            boolean loadEligible = true;
            if (unitRequiresAttestation && !agentCanAttest) {
                loadEligible = false;
                reasons.add("restricted: requires attestation the agent cannot present");
            }
            // 8. payment
            PaymentPlan payment = planPayment(unit.payment() != null ? unit.payment() : manifest.payment(), caps);
            if (!payment.affordable()) {
                loadEligible = false;
                reasons.add("unaffordable: " + payment.method());
            }
            // 9. access is the auth axis
            String access = unit.access();
            if ("authenticated".equals(access) || "restricted".equals(access)) {
                if (caps.credentials().isEmpty()) {
                    reasons.add("access '" + access + "': agent holds no credentials");
                    if ("restricted".equals(access)) {
                        loadEligible = false;
                    }
                    if ("x402".equals(payment.method())) {
                        reasons.add("hint: '" + access + "' + x402 — if this unit is anonymous-paid the manifest "
                                + "should mark it public (spec §4.11, v0.25.1)");
                    }
                }
            }
            // 10. strict
            if (options.strict() && !loadEligible) {
                String reason = reasons.isEmpty() ? "not load-eligible" : reasons.get(reasons.size() - 1);
                skipped.add(new SkippedUnit(unit.id(), reason));
                continue;
            }
            selected.add(new PlannedUnit(unit.id(), unit.path(), unit.intent(), sr.score(), reasons,
                    payment, unitRequiresAttestation, loadEligible));
        }

        // sort by score desc, then id asc (total, deterministic tie-break)
        selected.sort((a, b) -> {
            int byScore = Integer.compare(b.score(), a.score());
            return byScore != 0 ? byScore : a.id().compareTo(b.id());
        });

        // greedy selection: maxUnits, then money budget, then context budget
        PlanOptions.Budget budget = options.budget();
        String budgetCurrency = budget != null && budget.currency() != null ? budget.currency() : "USDC";
        BigDecimal upstreamSpent = budget != null && budget.spent() != null
                ? BigDecimal.valueOf(budget.spent()) : BigDecimal.ZERO;
        Integer contextBudget = options.contextBudget();
        Map<String, Unit> unitById = new HashMap<>();
        for (Unit mu : manifest.units()) {
            unitById.putIfAbsent(mu.id(), mu);
        }
        BigDecimal spend = BigDecimal.ZERO;
        long usedTokens = 0;
        int sawUnmeasured = 0;
        int beyondMax = 0;
        List<PlannedUnit> capped = new ArrayList<>();

        for (PlannedUnit u : selected) {
            if (capped.size() >= maxUnits) {
                beyondMax++;
                continue;
            }
            BigDecimal price = u.payment().pricePerRequest();
            if (budget != null && u.loadEligible() && price != null && price.compareTo(BigDecimal.ZERO) > 0) {
                BigDecimal amount = BigDecimal.valueOf(budget.amount());
                if (!budgetCurrency.equals(u.payment().currency())) {
                    skipped.add(new SkippedUnit(u.id(),
                            "over budget: costs " + orEmpty(u.payment().cost()) + ", budget is in " + budgetCurrency));
                    continue;
                }
                if (upstreamSpent.add(spend).add(price).compareTo(amount.add(EPSILON)) > 0) {
                    skipped.add(new SkippedUnit(u.id(),
                            "over budget: " + fmtNum(price) + " would exceed remaining "
                                    + fmtNum(money(amount.subtract(upstreamSpent).subtract(spend)))
                                    + " of " + fmtNum(amount) + " " + budgetCurrency));
                    continue;
                }
                spend = spend.add(price);
            }
            if (contextBudget != null && u.loadEligible()) {
                long cb = contextBudget;
                Unit mu = unitById.get(u.id());
                if (mu != null) {
                    TokenInfo info = unitTokens(mu);
                    if (!info.measured()) {
                        if (options.strict()) {
                            skipped.add(new SkippedUnit(u.id(),
                                    "size undeclared — excluded under strict (declare size_tokens or bytes)"));
                            continue;
                        }
                        sawUnmeasured++;
                    } else {
                        long tokens = info.tokens() != null ? info.tokens() : 0;
                        if (usedTokens + tokens > cb) {
                            skipped.add(new SkippedUnit(u.id(),
                                    "over context budget: " + fmtTokens(tokens) + " tokens would exceed remaining "
                                            + fmtTokens(cb - usedTokens) + " of " + fmtTokens(cb)));
                            continue;
                        }
                        usedTokens += tokens;
                    }
                }
            }
            capped.add(u);
        }

        if (beyondMax > 0) {
            warnings.add(beyondMax + " relevant unit(s) beyond maxUnits=" + maxUnits + " not selected");
        }
        if (contextBudget != null && sawUnmeasured > 0) {
            warnings.add(sawUnmeasured
                    + " selected unit(s) declare no size — the context projection is a lower bound (unmeasured)");
        }

        // federation: select sub-manifests by env context, note credential planning.
        List<FederationPlan> federation = new ArrayList<>();
        for (ManifestRef ref : manifest.manifests()) {
            boolean inEnv = ref.context() == null
                    || (options.env() != null && ref.context().contains(options.env()));
            String credentialNeeded = null;
            if (ref.agentIdentity() != null
                    && Boolean.TRUE.equals(ref.agentIdentity().required())
                    && ref.agentIdentity().credentialHint() != null
                    && !caps.credentials().contains(ref.agentIdentity().credentialHint())) {
                credentialNeeded = ref.agentIdentity().credentialHint();
            }
            String reason;
            if (!inEnv) {
                reason = options.env() != null
                        ? "context " + jsonArr(ref.context()) + " excludes env '" + options.env() + "'"
                        : "context " + jsonArr(ref.context()) + " requires a declared env; none given (fail-closed)";
            } else if (credentialNeeded != null) {
                reason = "needs " + credentialNeeded + " before fetch";
            } else {
                reason = "eligible";
            }
            federation.add(new FederationPlan(ref.id(), ref.url(), inEnv, reason, credentialNeeded,
                    ref.agentIdentity() != null ? ref.agentIdentity().docsUrl() : null));
        }

        BudgetPlan budgetPlan = planBudget(manifest, caps, capped, budget);
        ContextPlan contextPlan = planContext(manifest, capped, contextBudget);

        String trustNote = requiresAttestation
                ? (agentCanAttest
                        ? "manifest requires attestation; the agent can present it"
                        : "manifest requires attestation; the agent CANNOT — restricted units are gated")
                : "no manifest-level attestation requirement";

        return new AgentPlan(
                task,
                new AgentPlan.ManifestInfo(manifest.project(), manifest.version(), manifest.kcpVersion(), manifest.source()),
                new AgentPlan.TrustInfo(requiresAttestation, agentCanAttest, trustNote),
                options.env(),
                asOf,
                capped,
                skipped,
                federation,
                budgetPlan,
                contextPlan,
                warnings);
    }

    /** Plan with default options. */
    public static AgentPlan plan(Manifest manifest, String task) {
        return plan(manifest, task, PlanOptions.defaults());
    }

    // --- decision trace (ported from src/trace.ts) ---

    /** A unit's evolving trace state as it walks the two-phase gate cascade. */
    private static final class Candidate {
        final Unit unit;
        final List<GateVerdict> gates = new ArrayList<>();
        boolean rejected;
        GateName rejectedBy;
        int score;
        boolean loadEligible = true;
        PaymentPlan payment;

        Candidate(Unit unit, PaymentPlan payment) {
            this.unit = unit;
            this.payment = payment;
        }

        void reject(GateName gate, String detail) {
            gates.add(new GateVerdict(gate, false, detail));
            rejected = true;
            rejectedBy = gate;
        }

        void pass(GateName gate, String detail) {
            gates.add(new GateVerdict(gate, true, detail));
        }
    }

    /**
     * Produce a decision trace: the canonical plan annotated with per-unit gate
     * records. Pure — no I/O, no model. The embedded plan is the authority; the
     * trace re-walks the cascade only to record why each unit landed where it did.
     *
     * @param manifest the parsed manifest
     * @param task     the task to plan for
     * @param options  the planning options
     * @return the decision trace
     */
    public static DecisionTrace trace(Manifest manifest, String task, PlanOptions options) {
        AgentPlan p = plan(manifest, task, options);
        AgentCapabilities caps = options.capabilities();
        String asOf = options.asOf() != null ? options.asOf() : todayUtc();
        List<String> taskTerms = terms(task);
        int maxUnits = options.maxUnits();
        PlanOptions.Budget budget = options.budget();
        String budgetCurrency = budget != null && budget.currency() != null ? budget.currency() : "USDC";
        BigDecimal upstreamSpent = budget != null && budget.spent() != null
                ? BigDecimal.valueOf(budget.spent()) : BigDecimal.ZERO;
        Integer contextBudget = options.contextBudget();

        Set<String> selectedIds = new java.util.HashSet<>();
        for (PlannedUnit u : p.selected()) {
            selectedIds.add(u.id());
        }

        boolean requiresAttestation = manifest.trust() != null
                && manifest.trust().agentRequirements() != null
                && Boolean.TRUE.equals(manifest.trust().agentRequirements().requireAttestation());
        List<String> trustedProviders = requiresAttestation && manifest.trust().agentRequirements().trustedProviders() != null
                ? manifest.trust().agentRequirements().trustedProviders()
                : List.of();
        boolean agentCanAttest = !requiresAttestation
                || (caps.attestationProvider() != null && trustedProviders.contains(caps.attestationProvider()));

        // Phase 1: pre-selection gates (audience → strict), in manifest order.
        List<Candidate> candidates = new ArrayList<>();
        for (Unit unit : manifest.units()) {
            Candidate c = new Candidate(unit,
                    planPayment(unit.payment() != null ? unit.payment() : manifest.payment(), caps));

            // 1. audience
            if (!unit.audience().isEmpty() && !unit.audience().contains(caps.role())) {
                c.reject(GateName.AUDIENCE, "audience " + jsonArr(unit.audience()) + " excludes role '" + caps.role() + "'");
            } else {
                c.pass(GateName.AUDIENCE, unit.audience().isEmpty()
                        ? "no audience restriction"
                        : "role '" + caps.role() + "' in " + jsonArr(unit.audience()));
            }
            if (c.rejected) {
                candidates.add(c);
                continue;
            }
            // 2. not_for
            String nf = firstNotFor(unit.notFor(), taskTerms);
            if (nf != null) {
                c.reject(GateName.NOT_FOR, "not_for declares it does not serve '" + nf + "'");
            } else {
                c.pass(GateName.NOT_FOR, unit.notFor().isEmpty()
                        ? "no not_for declarations"
                        : "task terms do not match " + jsonArr(unit.notFor()));
            }
            if (c.rejected) {
                candidates.add(c);
                continue;
            }
            // 3. temporal
            TemporalStatus ts = temporalStatus(unit, asOf);
            if (ts == TemporalStatus.FUTURE) {
                c.reject(GateName.TEMPORAL, "not active until " + orEmpty(unit.temporal() != null ? unit.temporal().validFrom() : null));
            } else if (ts == TemporalStatus.EXPIRED) {
                String succ = unit.temporal() != null && unit.temporal().supersededBy() != null
                        ? " (superseded by " + unit.temporal().supersededBy() + ")" : "";
                c.reject(GateName.TEMPORAL, "expired " + orEmpty(unit.temporal() != null ? unit.temporal().validUntil() : null) + succ);
            } else {
                c.pass(GateName.TEMPORAL, unit.temporal() != null ? "active as-of " + asOf : "no temporal constraint");
            }
            if (c.rejected) {
                candidates.add(c);
                continue;
            }
            // 4. deprecated
            if (Boolean.TRUE.equals(unit.deprecated())) {
                c.reject(GateName.DEPRECATED, "deprecated");
            } else {
                c.pass(GateName.DEPRECATED, "not deprecated");
            }
            if (c.rejected) {
                candidates.add(c);
                continue;
            }
            // 5. supersession
            String successor = selectableSuccessor(unit, manifest, asOf, caps.role());
            if (successor != null) {
                c.reject(GateName.SUPERSESSION, "superseded by " + successor + " (successor active)");
            } else {
                c.pass(GateName.SUPERSESSION, unit.temporal() != null && unit.temporal().supersededBy() != null
                        ? "successor '" + unit.temporal().supersededBy() + "' not active"
                        : "no supersession declared");
            }
            if (c.rejected) {
                candidates.add(c);
                continue;
            }
            // 6. relevance
            ScoreResult sr = scoreUnit(unit, taskTerms);
            c.score = sr.score();
            if (c.score == 0) {
                c.reject(GateName.RELEVANCE, "no task-relevance match");
            } else {
                c.pass(GateName.RELEVANCE, "score " + c.score + ": " + String.join("; ", sr.reasons()));
            }
            if (c.rejected) {
                candidates.add(c);
                continue;
            }
            // 7. attestation
            boolean unitRequiresAttestation = requiresAttestation && "restricted".equals(unit.access());
            if (unitRequiresAttestation && !agentCanAttest) {
                c.loadEligible = false;
                c.pass(GateName.ATTESTATION, "restricted: requires attestation the agent cannot present (loadEligible=false)");
            } else {
                c.pass(GateName.ATTESTATION, unitRequiresAttestation
                        ? "agent can present required attestation" : "no attestation required");
            }
            // 8. payment
            if (!c.payment.affordable()) {
                c.loadEligible = false;
                c.pass(GateName.PAYMENT, "unaffordable: " + c.payment.method() + " (loadEligible=false)");
            } else {
                c.pass(GateName.PAYMENT, "free".equals(c.payment.method())
                        ? "free" : c.payment.method() + ": " + c.payment.cost());
            }
            // 9. access
            String access = unit.access();
            if (("authenticated".equals(access) || "restricted".equals(access)) && caps.credentials().isEmpty()) {
                if ("restricted".equals(access)) {
                    c.loadEligible = false;
                }
                c.pass(GateName.ACCESS, "access '" + access + "': agent holds no credentials"
                        + ("restricted".equals(access) ? " (loadEligible=false)" : ""));
            } else {
                c.pass(GateName.ACCESS, access != null
                        ? "access '" + access + "' — agent has credentials" : "public access");
            }
            // 10. strict
            if (options.strict() && !c.loadEligible) {
                c.reject(GateName.STRICT, "not load-eligible under strict mode");
            } else {
                c.pass(GateName.STRICT, options.strict() ? "load-eligible under strict mode" : "non-strict mode");
            }
            candidates.add(c);
        }

        // Phase 2: greedy-loop gates (max_units, money_budget, context_budget).
        List<Candidate> passed = new ArrayList<>();
        for (Candidate c : candidates) {
            if (!c.rejected) {
                passed.add(c);
            }
        }
        passed.sort((a, b) -> {
            int byScore = Integer.compare(b.score, a.score);
            return byScore != 0 ? byScore : a.unit.id().compareTo(b.unit.id());
        });

        int accepted = 0;
        BigDecimal spend = BigDecimal.ZERO;
        long usedTokens = 0;
        for (Candidate c : passed) {
            // 11. max_units
            if (accepted >= maxUnits) {
                c.reject(GateName.MAX_UNITS, "position " + (accepted + 1) + " exceeds cap of " + maxUnits);
                continue;
            }
            c.pass(GateName.MAX_UNITS, "position " + (accepted + 1) + " within cap of " + maxUnits);
            // 12. money_budget
            BigDecimal price = c.payment.pricePerRequest();
            if (budget != null && c.loadEligible && price != null && price.compareTo(BigDecimal.ZERO) > 0) {
                BigDecimal amount = BigDecimal.valueOf(budget.amount());
                if (!budgetCurrency.equals(c.payment.currency())) {
                    c.reject(GateName.MONEY_BUDGET, "costs " + orEmpty(c.payment.cost()) + ", budget is in " + budgetCurrency);
                    continue;
                }
                if (upstreamSpent.add(spend).add(price).compareTo(amount.add(EPSILON)) > 0) {
                    c.reject(GateName.MONEY_BUDGET, fmtNum(price) + " would exceed remaining "
                            + fmtNum(money(amount.subtract(upstreamSpent).subtract(spend))) + " of "
                            + fmtNum(amount) + " " + budgetCurrency);
                    continue;
                }
                spend = spend.add(price);
                c.pass(GateName.MONEY_BUDGET, fmtNum(price) + " within budget (" + fmtNum(money(spend))
                        + " of " + fmtNum(amount) + " " + budgetCurrency + " spent)");
            } else {
                c.pass(GateName.MONEY_BUDGET, budget != null ? "free unit" : "no budget ceiling set");
            }
            // 13. context_budget
            if (contextBudget != null && c.loadEligible) {
                long cb = contextBudget;
                TokenInfo info = unitTokens(c.unit);
                if (!info.measured()) {
                    if (options.strict()) {
                        c.reject(GateName.CONTEXT_BUDGET, "size undeclared — excluded under strict");
                        continue;
                    }
                    c.pass(GateName.CONTEXT_BUDGET, "unmeasured (admitted, projection is a lower bound)");
                } else {
                    long tokens = info.tokens() != null ? info.tokens() : 0;
                    if (usedTokens + tokens > cb) {
                        c.reject(GateName.CONTEXT_BUDGET, fmtTokens(tokens) + " tokens would exceed remaining "
                                + fmtTokens(cb - usedTokens) + " of " + fmtTokens(cb));
                        continue;
                    }
                    usedTokens += tokens;
                    c.pass(GateName.CONTEXT_BUDGET, fmtTokens(tokens) + " tokens ("
                            + fmtTokens(usedTokens) + " of " + fmtTokens(cb) + " used)");
                }
            } else {
                c.pass(GateName.CONTEXT_BUDGET, contextBudget != null ? "not load-eligible" : "no context budget set");
            }
            accepted++;
        }

        // Build UnitTrace from candidates, in manifest order.
        List<UnitTrace> unitTraces = new ArrayList<>();
        for (Candidate c : candidates) {
            String outcome = selectedIds.contains(c.unit.id()) ? "selected" : "skipped";
            Integer score = c.score > 0 ? c.score : null;
            UnitTrace.Tokens tokens = null;
            UnitTrace.Cost cost = null;
            if (outcome.equals("selected")) {
                TokenInfo ti = unitTokens(c.unit);
                String source = ti.measured() ? (ti.approximate() ? "estimated" : "declared") : "unmeasured";
                tokens = new UnitTrace.Tokens(ti.tokens(), source);
                if (!"free".equals(c.payment.method()) && c.payment.pricePerRequest() != null) {
                    cost = new UnitTrace.Cost(c.payment.pricePerRequest().doubleValue(),
                            c.payment.currency(), c.payment.method());
                }
            }
            unitTraces.add(new UnitTrace(c.unit.id(), c.unit.path(), c.unit.intent(), outcome,
                    List.copyOf(c.gates), c.rejectedBy, score, tokens, cost));
        }

        // Gate summary: pass/fail counts per gate across all units.
        List<DecisionTrace.GateCount> gateSummary = new ArrayList<>();
        for (GateName gate : GateName.ORDER) {
            int gpassed = 0;
            int gfailed = 0;
            for (UnitTrace ut : unitTraces) {
                for (GateVerdict v : ut.gates()) {
                    if (v.gate() == gate) {
                        if (v.passed()) {
                            gpassed++;
                        } else {
                            gfailed++;
                        }
                        break;
                    }
                }
            }
            gateSummary.add(new DecisionTrace.GateCount(gate, gpassed, gfailed));
        }

        return new DecisionTrace(task, taskTerms, p.asOf(), caps, p, unitTraces, gateSummary);
    }

    /** Trace with default options. */
    public static DecisionTrace trace(Manifest manifest, String task) {
        return trace(manifest, task, PlanOptions.defaults());
    }

    // --- plan diff (ported from src/diff.ts) ---

    /**
     * Compare two plan artifacts and report what changed: units that flipped
     * selected/skipped, score shifts, presence changes, budget/context shifts, skip
     * reason changes, and warning changes. Pure. The planner is deterministic, so
     * every difference has a cause.
     *
     * @param a the first plan
     * @param b the second plan
     * @return the diff
     */
    public static PlanDiff diffPlans(AgentPlan a, AgentPlan b) {
        Map<String, Integer> aSel = new HashMap<>();
        Map<String, String> aSkip = new HashMap<>();
        Map<String, Integer> bSel = new HashMap<>();
        Map<String, String> bSkip = new HashMap<>();
        for (PlannedUnit u : a.selected()) {
            aSel.putIfAbsent(u.id(), u.score());
        }
        for (SkippedUnit s : a.skipped()) {
            aSkip.putIfAbsent(s.id(), s.reason());
        }
        for (PlannedUnit u : b.selected()) {
            bSel.putIfAbsent(u.id(), u.score());
        }
        for (SkippedUnit s : b.skipped()) {
            bSkip.putIfAbsent(s.id(), s.reason());
        }

        // Ordered, deduped union of ids: a.selected, a.skipped, then b — matches the TS Set order.
        Set<String> allIds = new LinkedHashSet<>();
        for (PlannedUnit u : a.selected()) {
            allIds.add(u.id());
        }
        for (SkippedUnit s : a.skipped()) {
            allIds.add(s.id());
        }
        for (PlannedUnit u : b.selected()) {
            allIds.add(u.id());
        }
        for (SkippedUnit s : b.skipped()) {
            allIds.add(s.id());
        }

        List<UnitMove> moves = new ArrayList<>();
        List<ScoreChange> scoreChanges = new ArrayList<>();
        List<UnitPresence> presence = new ArrayList<>();
        List<ReasonChange> reasonChanges = new ArrayList<>();

        for (String id : allIds) {
            boolean inA = aSel.containsKey(id) || aSkip.containsKey(id);
            boolean inB = bSel.containsKey(id) || bSkip.containsKey(id);
            if (inA && !inB) {
                presence.add(new UnitPresence(id, "a_only"));
                continue;
            }
            if (!inA && inB) {
                presence.add(new UnitPresence(id, "b_only"));
                continue;
            }
            Integer selA = aSel.get(id);
            Integer selB = bSel.get(id);
            String skipA = aSkip.get(id);
            String skipB = bSkip.get(id);
            if (selA != null && skipB != null) {
                moves.add(new UnitMove(id, "selected_to_skipped",
                        new UnitMove.MoveSide(selA, null), new UnitMove.MoveSide(null, skipB)));
            } else if (skipA != null && selB != null) {
                moves.add(new UnitMove(id, "skipped_to_selected",
                        new UnitMove.MoveSide(null, skipA), new UnitMove.MoveSide(selB, null)));
            } else if (selA != null && selB != null && !selA.equals(selB)) {
                scoreChanges.add(new ScoreChange(id, selA, selB, selB - selA));
            } else if (skipA != null && skipB != null && !skipA.equals(skipB)) {
                reasonChanges.add(new ReasonChange(id, skipA, skipB));
            }
        }

        List<BudgetShift> budgetShifts = new ArrayList<>();
        addShift(budgetShifts, "budget.ceiling", toDouble(a.budget().ceiling()), toDouble(b.budget().ceiling()));
        addShift(budgetShifts, "budget.projectedSpend", toDouble(a.budget().projectedSpend()), toDouble(b.budget().projectedSpend()));
        addShift(budgetShifts, "budget.remaining", toDouble(a.budget().remaining()), toDouble(b.budget().remaining()));
        addShift(budgetShifts, "context.ceiling", toDouble(a.context().ceiling()), toDouble(b.context().ceiling()));
        addShift(budgetShifts, "context.projectedTokens", toDouble(a.context().projectedTokens()), toDouble(b.context().projectedTokens()));
        addShift(budgetShifts, "context.remaining", toDouble(a.context().remaining()), toDouble(b.context().remaining()));

        List<String> added = new ArrayList<>();
        for (String w : b.warnings()) {
            if (!a.warnings().contains(w)) {
                added.add(w);
            }
        }
        List<String> removed = new ArrayList<>();
        for (String w : a.warnings()) {
            if (!b.warnings().contains(w)) {
                removed.add(w);
            }
        }

        boolean identical = moves.isEmpty() && scoreChanges.isEmpty() && presence.isEmpty()
                && budgetShifts.isEmpty() && reasonChanges.isEmpty() && added.isEmpty() && removed.isEmpty();

        return new PlanDiff(
                new PlanDiff.DiffEnd(a.manifest().project(), a.manifest().version(), a.task(), a.asOf()),
                new PlanDiff.DiffEnd(b.manifest().project(), b.manifest().version(), b.task(), b.asOf()),
                identical, moves, scoreChanges, presence, budgetShifts, reasonChanges,
                new PlanDiff.WarningChanges(added, removed));
    }

    private static void addShift(List<BudgetShift> shifts, String field, Double before, Double after) {
        if (!Objects.equals(before, after)) {
            shifts.add(new BudgetShift(field, before, after));
        }
    }

    private static Double toDouble(BigDecimal v) {
        return v == null ? null : v.doubleValue();
    }

    private static Double toDouble(Long v) {
        return v == null ? null : v.doubleValue();
    }

    // --- budget / context projection (ported from budget.rs) ---

    private static BudgetPlan planBudget(Manifest manifest, AgentCapabilities caps,
            List<PlannedUnit> selected, PlanOptions.Budget budget) {
        RateLimits rl = manifest.rateLimits();
        String tier = "default";
        if (caps.paymentMethods().contains("subscription") && rl != null && rl.premium() != null) {
            tier = "premium";
        } else if (!caps.credentials().isEmpty() && rl != null && rl.authenticated() != null) {
            tier = "authenticated";
        }
        RequestCount requestsPerMinute = tierRequestsPerMinute(rl, tier);

        List<PlannedUnit> loadable = new ArrayList<>();
        for (PlannedUnit u : selected) {
            if (u.loadEligible()) {
                loadable.add(u);
            }
        }
        List<BudgetPlan.PerRequestCost> perRequestCosts = new ArrayList<>();
        BigDecimal projectedSum = BigDecimal.ZERO;
        for (PlannedUnit u : loadable) {
            if ("x402".equals(u.payment().method()) && u.payment().cost() != null) {
                perRequestCosts.add(new BudgetPlan.PerRequestCost(u.id(), u.payment().cost()));
            }
            if (u.payment().pricePerRequest() != null) {
                projectedSum = projectedSum.add(u.payment().pricePerRequest());
            }
        }
        BigDecimal projectedSpend = money(projectedSum);

        if (budget == null) {
            String note = !perRequestCosts.isEmpty()
                    ? perRequestCosts.size() + " selected unit(s) are pay-per-request; budget before loading."
                    : "all selected units are free to load at the resolved tier.";
            return new BudgetPlan(tier, requestsPerMinute, perRequestCosts, null, null, null, null, null, note);
        }
        String currency = budget.currency() != null ? budget.currency() : "USDC";
        BigDecimal amount = BigDecimal.valueOf(budget.amount());
        BigDecimal spent = money(budget.spent() != null ? BigDecimal.valueOf(budget.spent()) : BigDecimal.ZERO);
        BigDecimal remaining = money(amount.subtract(spent).subtract(projectedSpend));
        boolean committed = spent.compareTo(BigDecimal.ZERO) > 0;
        String note = "projected spend " + fmtNum(projectedSpend)
                + (committed ? " (+" + fmtNum(spent) + " committed upstream)" : "")
                + " of " + fmtNum(amount) + " " + currency + "; " + fmtNum(remaining) + " remaining.";
        return new BudgetPlan(tier, requestsPerMinute, perRequestCosts, amount, currency,
                committed ? spent : null, projectedSpend, remaining, note);
    }

    private static RequestCount tierRequestsPerMinute(RateLimits rl, String tier) {
        if (rl == null) {
            return null;
        }
        RateLimitTier block = switch (tier) {
            case "premium" -> rl.premium();
            case "authenticated" -> rl.authenticated();
            default -> rl.defaultTier();
        };
        return block != null ? block.requestsPerMinute() : null;
    }

    private static ContextPlan planContext(Manifest manifest, List<PlannedUnit> selected, Integer ceiling) {
        Map<String, Unit> byId = new HashMap<>();
        for (Unit u : manifest.units()) {
            byId.putIfAbsent(u.id(), u);
        }
        long projectedTokens = 0;
        boolean approximate = false;
        int unmeasured = 0;
        for (PlannedUnit s : selected) {
            if (!s.loadEligible()) {
                continue;
            }
            Unit u = byId.get(s.id());
            TokenInfo info = u != null ? unitTokens(u) : new TokenInfo(null, false, false);
            if (!info.measured()) {
                unmeasured++;
                continue;
            }
            projectedTokens += info.tokens() != null ? info.tokens() : 0;
            if (info.approximate()) {
                approximate = true;
            }
        }
        if (ceiling == null) {
            return new ContextPlan(null, null, null, approximate, unmeasured, "no context budget set.");
        }
        long c = ceiling;
        long remaining = c - projectedTokens;
        List<String> flags = new ArrayList<>();
        if (approximate) {
            flags.add("some sizes estimated");
        }
        if (unmeasured > 0) {
            flags.add(unmeasured + " unmeasured");
        }
        String flagStr = flags.isEmpty() ? "" : " (" + String.join(", ", flags) + ")";
        String note = "projected " + fmtTokens(projectedTokens) + " of " + fmtTokens(c) + " tokens; "
                + fmtTokens(remaining) + " remaining" + flagStr + ".";
        return new ContextPlan(c, projectedTokens, remaining, approximate, unmeasured, note);
    }

    // --- number / string formatting (ported from budget.rs + planner.rs) ---

    /** Round to 6 decimals, matching {@code Number(n.toFixed(6))}. */
    private static BigDecimal money(BigDecimal n) {
        return n.setScale(6, RoundingMode.HALF_UP);
    }

    /**
     * Format a decimal the way JS {@code ${n}} does for the clean decimals used in
     * budgets (shortest round-trip, no trailing zeros): {@code 0} → "0", {@code 0.05}
     * → "0.05". Normalizes negative zero to "0".
     */
    private static String fmtNum(BigDecimal n) {
        if (n.compareTo(BigDecimal.ZERO) == 0) {
            return "0";
        }
        return n.stripTrailingZeros().toPlainString();
    }

    /** Thousands-separated integer for readable token arithmetic (1240 → "1,240"). */
    private static String fmtTokens(long n) {
        return String.format(Locale.US, "%,d", n);
    }

    private static BigDecimal parseDecimal(String s) {
        if (s == null) {
            return null;
        }
        try {
            return new BigDecimal(s.trim());
        } catch (NumberFormatException e) {
            return null; // JS Number("abc") is NaN → pricePerRequest undefined
        }
    }

    private static String firstNotFor(List<String> notFor, List<String> taskTerms) {
        for (String n : notFor) {
            String low = n.toLowerCase(Locale.ROOT);
            for (String t : taskTerms) {
                if (low.contains(t)) {
                    return n;
                }
            }
        }
        return null;
    }

    private static String orEmpty(String s) {
        return s != null ? s : "";
    }

    /** UTC "today" as {@code YYYY-MM-DD}, without relying on locale. */
    private static String todayUtc() {
        return LocalDate.now(ZoneOffset.UTC).toString();
    }

    /** JSON-serialize a string array compactly ({@code ["a","b"]}), matching {@code JSON.stringify}. */
    static String jsonArr(List<String> values) {
        StringBuilder sb = new StringBuilder("[");
        for (int i = 0; i < values.size(); i++) {
            if (i > 0) {
                sb.append(',');
            }
            jsonString(sb, values.get(i));
        }
        return sb.append(']').toString();
    }

    private static void jsonString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\b' -> sb.append("\\b");
                case '\f' -> sb.append("\\f");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        sb.append('"');
    }
}
