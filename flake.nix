{
  description = "ephemeral agent fleet — nspawn + headless opencode control plane";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        packages = [
          pkgs.nodejs_24 # orchestrator (opencode SDK is TS/JS)
          pkgs.git
          pkgs.opencode
        ];
        shellHook = ''
          echo "fleet dev shell"
          echo "  node:     $(node --version)"
          echo "  opencode: $(opencode --version 2>/dev/null || echo 'n/a')"
        '';
      };

      # Reusable NixOS container definition for a single agent.
      nixosModules.fleet-agent = import ./image/fleet-agent.nix;

      # Concrete instantiation the provisioner boots as an ephemeral systemd-nspawn
      # container. See docs/architecture.md and ADR 0001.
      nixosConfigurations.fleet-agent = nixpkgs.lib.nixosSystem {
        inherit system;
        modules = [ self.nixosModules.fleet-agent ];
      };

      # The dedicated host that runs those containers. It pins the container system so the
      # host store already contains it.
      nixosConfigurations.fleet-host = nixpkgs.lib.nixosSystem {
        inherit system;
        specialArgs = {
          fleetContainer = self.nixosConfigurations.fleet-agent.config.system.build.toplevel;
          fleetEgressProxy = self.packages.${system}.fleet-egress-proxy;
          fleetOrchestrator = self.packages.${system}.fleet-orchestrator;
        };
        modules = [ ./host/fleet-host.nix ];
      };

      packages.${system} = {
        # A runnable QEMU VM of the host, for local development.
        fleet-host-vm = self.nixosConfigurations.fleet-host.config.system.build.vm;

        # Host-side default-deny egress proxy (no npm deps; runs on node with type stripping).
        fleet-egress-proxy = pkgs.writeShellApplication {
          name = "fleet-egress-proxy";
          runtimeInputs = [ pkgs.nodejs_24 ];
          text = ''
            exec node ${./orchestrator/src/egress}/main.ts
          '';
        };

        # The orchestrator daemon (Node + the `yaml` dep), for the fleet-host systemd service.
        fleet-orchestrator = pkgs.buildNpmPackage {
          pname = "fleet-orchestrator";
          version = "0.0.0";
          src = ./orchestrator;
          npmDeps = pkgs.importNpmLock { npmRoot = ./orchestrator; };
          npmConfigHook = pkgs.importNpmLock.npmConfigHook;
          dontNpmBuild = true;
          nativeBuildInputs = [ pkgs.makeWrapper ];
          installPhase = ''
            runHook preInstall
            mkdir -p $out/lib
            cp -r src node_modules package.json $out/lib/
            makeWrapper ${pkgs.nodejs_24}/bin/node $out/bin/fleet-orchestrator \
              --add-flags "$out/lib/src/main.ts" \
              --prefix PATH : ${pkgs.lib.makeBinPath [ pkgs.git ]}
            runHook postInstall
          '';
        };
      };
    };
}
