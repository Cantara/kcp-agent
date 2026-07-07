package no.cantara.kcp.planner.spring;

import java.lang.annotation.Documented;
import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

import org.springframework.context.annotation.Import;

/**
 * Opt in to the KCP planner from a non-Boot Spring application. In a Spring Boot app the
 * planner auto-configures without this annotation; a plain {@code @Configuration}-based
 * app can add {@code @EnableKcpPlanner} to import the same beans.
 */
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
@Documented
@Import({KcpPlannerAutoConfiguration.class, KcpPlannerHealthAutoConfiguration.class})
public @interface EnableKcpPlanner {
}
