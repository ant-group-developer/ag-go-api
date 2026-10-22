import { Controller, Get } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { GO_PERMISSIONS } from './permissions.constants';
import { AdminOnly, RequireAnyPermissions, RequirePermissions } from './permissions.decorator';
import { RouteAuthValidatorService, validateRouteDecorators } from './route-auth-validator.service';
import { ServiceOnly } from './service-only.decorator';

describe('RouteAuthValidator', () => {
  const reflector = new Reflector();
  const metadataScanner = new MetadataScanner();

  it('passes when controllers have distinct and properly configured decorators', () => {
    @Controller('valid')
    class ValidController {
      @Get('user-only')
      @RequirePermissions(GO_PERMISSIONS.PROJECT_READ)
      userRoute() {}

      @Get('service-only')
      @ServiceOnly('usage:write')
      serviceRoute() {}
    }

    const instance = new ValidController();
    expect(() =>
      validateRouteDecorators(
        [{ instance, metatype: ValidController }],
        reflector,
        metadataScanner,
      ),
    ).not.toThrow();
  });

  it('throws when a method combines @ServiceOnly and @RequirePermissions', () => {
    @Controller('invalid-method')
    class InvalidMethodController {
      @Get('conflict')
      @ServiceOnly('usage:write')
      @RequirePermissions(GO_PERMISSIONS.PROJECT_READ)
      conflictRoute() {}
    }

    const instance = new InvalidMethodController();
    expect(() =>
      validateRouteDecorators(
        [{ instance, metatype: InvalidMethodController }],
        reflector,
        metadataScanner,
      ),
    ).toThrow(
      'Invalid route configuration: Method "InvalidMethodController.conflictRoute" combines @ServiceOnly with @RequirePermissions. Service-only routes cannot require user permissions.',
    );
  });

  it('throws when a method combines @ServiceOnly and @RequireAnyPermissions', () => {
    @Controller('invalid-any')
    class InvalidAnyController {
      @Get('conflict-any')
      @ServiceOnly('usage:write')
      @RequireAnyPermissions(GO_PERMISSIONS.PROJECT_READ)
      conflictAny() {}
    }

    const instance = new InvalidAnyController();
    expect(() =>
      validateRouteDecorators(
        [{ instance, metatype: InvalidAnyController }],
        reflector,
        metadataScanner,
      ),
    ).toThrow(
      'Invalid route configuration: Method "InvalidAnyController.conflictAny" combines @ServiceOnly with @RequirePermissions. Service-only routes cannot require user permissions.',
    );
  });

  it('throws when a method combines @ServiceOnly and @AdminOnly', () => {
    @Controller('invalid-admin')
    class InvalidAdminController {
      @Get('conflict-admin')
      @ServiceOnly('usage:write')
      @AdminOnly()
      conflictAdmin() {}
    }

    const instance = new InvalidAdminController();
    expect(() =>
      validateRouteDecorators(
        [{ instance, metatype: InvalidAdminController }],
        reflector,
        metadataScanner,
      ),
    ).toThrow(
      'Invalid route configuration: Method "InvalidAdminController.conflictAdmin" combines @ServiceOnly with @RequirePermissions. Service-only routes cannot require user permissions.',
    );
  });

  it('throws when class has @ServiceOnly and method has @RequirePermissions', () => {
    @Controller('class-service-only')
    @ServiceOnly('usage:write')
    class ClassServiceOnlyController {
      @Get('method-permissions')
      @RequirePermissions(GO_PERMISSIONS.PROJECT_READ)
      methodPermissions() {}
    }

    const instance = new ClassServiceOnlyController();
    expect(() =>
      validateRouteDecorators(
        [{ instance, metatype: ClassServiceOnlyController }],
        reflector,
        metadataScanner,
      ),
    ).toThrow(
      'Invalid route configuration: Method "ClassServiceOnlyController.methodPermissions" combines @ServiceOnly with @RequirePermissions. Service-only routes cannot require user permissions.',
    );
  });

  it('throws when class has @RequirePermissions and method has @ServiceOnly', () => {
    @Controller('class-permissions')
    @RequirePermissions(GO_PERMISSIONS.PROJECT_READ)
    class ClassPermissionsController {
      @Get('method-service-only')
      @ServiceOnly('usage:write')
      methodServiceOnly() {}
    }

    const instance = new ClassPermissionsController();
    expect(() =>
      validateRouteDecorators(
        [{ instance, metatype: ClassPermissionsController }],
        reflector,
        metadataScanner,
      ),
    ).toThrow(
      'Invalid route configuration: Method "ClassPermissionsController.methodServiceOnly" combines @ServiceOnly with @RequirePermissions. Service-only routes cannot require user permissions.',
    );
  });

  it('throws when class has both @ServiceOnly and @RequirePermissions', () => {
    @Controller('both-on-class')
    @ServiceOnly('usage:write')
    @RequirePermissions(GO_PERMISSIONS.PROJECT_READ)
    class BothOnClassController {
      @Get('endpoint')
      endpoint() {}
    }

    const instance = new BothOnClassController();
    expect(() =>
      validateRouteDecorators(
        [{ instance, metatype: BothOnClassController }],
        reflector,
        metadataScanner,
      ),
    ).toThrow(
      'Invalid route configuration: Controller "BothOnClassController" combines @ServiceOnly with @RequirePermissions. Service-only routes cannot require user permissions.',
    );
  });

  it('RouteAuthValidatorService.onModuleInit queries discoveryService and runs validation', () => {
    @Controller('test-discovery')
    class DiscoveryTestController {
      @Get('ok')
      ok() {}
    }

    const instance = new DiscoveryTestController();
    const discoveryService = {
      getControllers: jest.fn().mockReturnValue([{ instance, metatype: DiscoveryTestController }]),
    } as unknown as DiscoveryService;

    const service = new RouteAuthValidatorService(discoveryService, metadataScanner, reflector);
    expect(() => service.onModuleInit()).not.toThrow();
    expect(discoveryService.getControllers).toHaveBeenCalled();
  });
});
