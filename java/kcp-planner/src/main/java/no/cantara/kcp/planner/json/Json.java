package no.cantara.kcp.planner.json;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

/**
 * A minimal JSON writer that reproduces {@code JSON.stringify(value, null, 2)}
 * byte-for-byte for the value types the planner emits: ordered objects
 * ({@link java.util.LinkedHashMap}), arrays ({@link java.util.List}), strings,
 * numbers, booleans, and null.
 *
 * <p>Number formatting matches JavaScript: a whole value prints as an integer
 * ({@code 3000}, not {@code 3000.0}); {@link BigDecimal} money keeps its significant
 * decimals with trailing zeros stripped ({@code 0.25}); negative zero is {@code 0}.</p>
 */
public final class Json {

    private Json() {
    }

    /** Serialize a value tree to pretty JSON (2-space indent), matching {@code JSON.stringify(v, null, 2)}. */
    public static String write(Object value) {
        StringBuilder sb = new StringBuilder();
        write(value, sb, 0);
        return sb.toString();
    }

    private static void write(Object v, StringBuilder sb, int indent) {
        if (v == null) {
            sb.append("null");
        } else if (v instanceof String s) {
            writeString(s, sb);
        } else if (v instanceof Boolean b) {
            sb.append(b ? "true" : "false");
        } else if (v instanceof Number n) {
            sb.append(number(n));
        } else if (v instanceof Map<?, ?> m) {
            writeObject(m, sb, indent);
        } else if (v instanceof List<?> l) {
            writeArray(l, sb, indent);
        } else {
            throw new IllegalArgumentException("cannot serialize " + v.getClass());
        }
    }

    private static void writeObject(Map<?, ?> m, StringBuilder sb, int indent) {
        if (m.isEmpty()) {
            sb.append("{}");
            return;
        }
        sb.append("{\n");
        int next = indent + 2;
        int i = 0;
        for (Map.Entry<?, ?> e : m.entrySet()) {
            if (i++ > 0) {
                sb.append(",\n");
            }
            pad(sb, next);
            writeString(e.getKey().toString(), sb);
            sb.append(": ");
            write(e.getValue(), sb, next);
        }
        sb.append('\n');
        pad(sb, indent);
        sb.append('}');
    }

    private static void writeArray(List<?> l, StringBuilder sb, int indent) {
        if (l.isEmpty()) {
            sb.append("[]");
            return;
        }
        sb.append("[\n");
        int next = indent + 2;
        for (int i = 0; i < l.size(); i++) {
            if (i > 0) {
                sb.append(",\n");
            }
            pad(sb, next);
            write(l.get(i), sb, next);
        }
        sb.append('\n');
        pad(sb, indent);
        sb.append(']');
    }

    /** JS {@code JSON.stringify} number formatting. */
    static String number(Number n) {
        if (n instanceof BigDecimal bd) {
            return bd.signum() == 0 ? "0" : bd.stripTrailingZeros().toPlainString();
        }
        if (n instanceof Double || n instanceof Float) {
            double d = n.doubleValue();
            if (d == 0.0) {
                return "0"; // JS String(-0) is "0"
            }
            if (d == Math.rint(d) && !Double.isInfinite(d)) {
                return Long.toString((long) d);
            }
            return Double.toString(d);
        }
        return n.toString(); // Long / Integer
    }

    private static void writeString(String s, StringBuilder sb) {
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

    private static void pad(StringBuilder sb, int n) {
        for (int i = 0; i < n; i++) {
            sb.append(' ');
        }
    }
}
