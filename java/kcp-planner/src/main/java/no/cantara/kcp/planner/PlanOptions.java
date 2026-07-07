package no.cantara.kcp.planner;

import java.util.List;

/**
 * The knobs a caller can turn when planning. Every field is optional; unset
 * fields fall back to the same defaults the TypeScript reference uses (role
 * {@code "agent"}, {@code maxUnits} 5, non-strict, no budgets). Mirrors
 * {@code PlanOptions} + the partial-{@code capabilities} merge in {@code src/planner.ts}.
 *
 * <p>Build with {@link #builder()}:</p>
 * <pre>{@code
 * PlanOptions opts = PlanOptions.builder()
 *     .role("developer")
 *     .maxUnits(10)
 *     .strict(true)
 *     .budget(0.05, "USDC")
 *     .contextBudget(4000)
 *     .build();
 * }</pre>
 */
public final class PlanOptions {

    /** A spend ceiling for pay-per-request units, tree-wide across a federated walk. */
    public record Budget(double amount, String currency, Double spent) {
    }

    private final String role;
    private final List<String> paymentMethods;
    private final List<String> credentials;
    private final String attestationProvider;
    private final String env;
    private final String asOf;
    private final Integer maxUnits;
    private final Boolean strict;
    private final Budget budget;
    private final Integer contextBudget;

    private PlanOptions(Builder b) {
        this.role = b.role;
        this.paymentMethods = b.paymentMethods;
        this.credentials = b.credentials;
        this.attestationProvider = b.attestationProvider;
        this.env = b.env;
        this.asOf = b.asOf;
        this.maxUnits = b.maxUnits;
        this.strict = b.strict;
        this.budget = b.budget;
        this.contextBudget = b.contextBudget;
    }

    /** The default options — every field unset. */
    public static PlanOptions defaults() {
        return builder().build();
    }

    /** Resolve the agent capabilities, applying the per-field defaults (partial merge). */
    public AgentCapabilities capabilities() {
        return new AgentCapabilities(
                role != null ? role : AgentCapabilities.DEFAULT.role(),
                paymentMethods != null ? paymentMethods : AgentCapabilities.DEFAULT.paymentMethods(),
                credentials != null ? credentials : AgentCapabilities.DEFAULT.credentials(),
                attestationProvider != null ? attestationProvider : AgentCapabilities.DEFAULT.attestationProvider());
    }

    /** The runtime environment for federation {@code context} selection, or {@code null}. */
    public String env() {
        return env;
    }

    /** The point-in-time (ISO date) for temporal evaluation, or {@code null} for "today". */
    public String asOf() {
        return asOf;
    }

    /** The maximum number of units to select (default 5). */
    public int maxUnits() {
        return maxUnits != null ? maxUnits : 5;
    }

    /** Whether to fail closed on units that are not load-eligible (default false). */
    public boolean strict() {
        return strict != null && strict;
    }

    /** The spend ceiling, or {@code null} when the caller planned without one. */
    public Budget budget() {
        return budget;
    }

    /** The token ceiling, or {@code null} when the caller planned without one. */
    public Integer contextBudget() {
        return contextBudget;
    }

    /** Start building a set of options. */
    public static Builder builder() {
        return new Builder();
    }

    /** A fluent builder for {@link PlanOptions}. */
    public static final class Builder {
        private String role;
        private List<String> paymentMethods;
        private List<String> credentials;
        private String attestationProvider;
        private String env;
        private String asOf;
        private Integer maxUnits;
        private Boolean strict;
        private Budget budget;
        private Integer contextBudget;

        /** Set the agent role. */
        public Builder role(String role) {
            this.role = role;
            return this;
        }

        /** Set the payment method types the agent can settle. */
        public Builder paymentMethods(List<String> methods) {
            this.paymentMethods = methods;
            return this;
        }

        /** Set the credential kinds the agent holds. */
        public Builder credentials(List<String> credentials) {
            this.credentials = credentials;
            return this;
        }

        /** Set the attestation provider the agent can prove. */
        public Builder attestationProvider(String provider) {
            this.attestationProvider = provider;
            return this;
        }

        /** Set the runtime environment for federation selection. */
        public Builder env(String env) {
            this.env = env;
            return this;
        }

        /** Set the point-in-time (ISO date) for temporal evaluation. */
        public Builder asOf(String asOf) {
            this.asOf = asOf;
            return this;
        }

        /** Set the maximum number of units to select. */
        public Builder maxUnits(int maxUnits) {
            this.maxUnits = maxUnits;
            return this;
        }

        /** Set fail-closed mode. */
        public Builder strict(boolean strict) {
            this.strict = strict;
            return this;
        }

        /** Set a spend ceiling in the given currency. */
        public Builder budget(double amount, String currency) {
            this.budget = new Budget(amount, currency, null);
            return this;
        }

        /** Set a spend ceiling (currency defaults to USDC in the plan). */
        public Builder budget(double amount) {
            this.budget = new Budget(amount, null, null);
            return this;
        }

        /** Set a full spend ceiling, including any amount already committed upstream. */
        public Builder budget(Budget budget) {
            this.budget = budget;
            return this;
        }

        /** Set a token ceiling for the model's context window. */
        public Builder contextBudget(int contextBudget) {
            this.contextBudget = contextBudget;
            return this;
        }

        /** Build the immutable options. */
        public PlanOptions build() {
            return new PlanOptions(this);
        }
    }
}
