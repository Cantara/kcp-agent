/**
 * The deterministic KCP planner for the JVM — a Java port of the kcp-agent
 * reference core, validated against the shared conformance vectors.
 *
 * <p>{@link no.cantara.kcp.planner.KcpPlanner#plan} turns a {@code knowledge.yaml}
 * manifest and a task into an inspectable load plan. The core is pure computation:
 * no LLM, no I/O.</p>
 */
module no.cantara.kcp.planner {
    requires org.snakeyaml.engine.v2;
    requires java.net.http;

    exports no.cantara.kcp.planner;
    exports no.cantara.kcp.planner.model;
    exports no.cantara.kcp.planner.trace;
    exports no.cantara.kcp.planner.diff;
    exports no.cantara.kcp.planner.verify;
    exports no.cantara.kcp.planner.client;
    exports no.cantara.kcp.planner.json;
}
