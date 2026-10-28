import { Injectable, OnModuleInit } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import {
  ADMIN_ONLY_KEY,
  ANY_PERMISSIONS_KEY,
  REQUIRED_PERMISSIONS_KEY,
} from './permissions.decorator';
import { SERVICE_ONLY_SCOPE_KEY } from './service-only.decorator';

export interface ControllerWrapperLike {
  instance?: unknown;
  metatype?: unknown;
}

/**
 * Validates that no route handler or controller class combines `@ServiceOnly` with `@RequirePermissions`
 * (or any user permission decorators like `@RequireAnyPermissions` / `@AdminOnly`), because service-only
 * routes authenticate external services without an act-as user.
 */
export function validateRouteDecorators(
  controllers: ControllerWrapperLike[],
  reflector: Reflector,
  metadataScanner?: MetadataScanner,
): void {
  for (const wrapper of controllers) {
    const { instance, metatype } = wrapper;
    if (!instance || typeof metatype !== 'function') {
      continue;
    }

    const controllerName = metatype.name;
    const classServiceOnly = reflector.get<string | undefined>(SERVICE_ONLY_SCOPE_KEY, metatype);
    const classPermissions =
      reflector.get<unknown>(REQUIRED_PERMISSIONS_KEY, metatype) ??
      reflector.get<unknown>(ANY_PERMISSIONS_KEY, metatype) ??
      reflector.get<unknown>(ADMIN_ONLY_KEY, metatype);

    if (classServiceOnly && classPermissions) {
      throw new Error(
        `Invalid route configuration: Controller "${controllerName}" combines @ServiceOnly with @RequirePermissions. Service-only routes cannot require user permissions.`,
      );
    }

    const prototype = Object.getPrototypeOf(instance);
    const methodNames = metadataScanner
      ? metadataScanner.getAllMethodNames(prototype)
      : Object.getOwnPropertyNames(prototype).filter(
          (m) =>
            m !== 'constructor' && typeof (instance as Record<string, unknown>)[m] === 'function',
        );

    for (const methodName of methodNames) {
      const handler = (instance as Record<string, unknown>)[methodName];
      if (typeof handler !== 'function') {
        continue;
      }

      const methodServiceOnly = reflector.get<string | undefined>(SERVICE_ONLY_SCOPE_KEY, handler);
      const methodPermissions =
        reflector.get<unknown>(REQUIRED_PERMISSIONS_KEY, handler) ??
        reflector.get<unknown>(ANY_PERMISSIONS_KEY, handler) ??
        reflector.get<unknown>(ADMIN_ONLY_KEY, handler);

      const isServiceOnly = methodServiceOnly ?? classServiceOnly;
      const isRequirePermissions = methodPermissions ?? classPermissions;

      if (isServiceOnly && isRequirePermissions) {
        throw new Error(
          `Invalid route configuration: Method "${controllerName}.${methodName}" combines @ServiceOnly with @RequirePermissions. Service-only routes cannot require user permissions.`,
        );
      }
    }
  }
}

@Injectable()
export class RouteAuthValidatorService implements OnModuleInit {
  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly reflector: Reflector,
  ) {}

  onModuleInit(): void {
    const controllers = this.discoveryService.getControllers();
    validateRouteDecorators(controllers, this.reflector, this.metadataScanner);
  }
}
