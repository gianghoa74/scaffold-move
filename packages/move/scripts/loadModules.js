const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { AptosClient } = require('aptos'); // Assuming you're using the Aptos SDK for JavaScript
const axios = require('axios'); // Add axios to make HTTP requests
const { loadExternalModules } = require('../move.config.ts'); // Import from move.config.ts
const deploymentsDir = path.join(__dirname, '../deployments');

// Paths to the relevant files
const moveTomlPath = path.join(__dirname, '../Move.toml');
const configYamlPath = path.join(__dirname, '../.aptos/config.yaml');
const deployedModulesPath = path.join(__dirname, '../../../packages/nextjs/modules/deployedModules.ts');
const externalModulesPath = path.join(__dirname, '../../../packages/nextjs/modules/externalModules.ts');

// Function to parse the TOML file and extract addresses
function parseToml(filePath) {
  const toml = fs.readFileSync(filePath, 'utf-8');
  const addressesSection = toml.match(/\[addresses\]([\s\S]*?)(?=\[|$)/);
  if (addressesSection) {
    const addresses = {};
    const lines = addressesSection[1].trim().split('\n');
    lines.forEach(line => {
      const [key, value] = line.split('=').map(part => part.trim().replace(/['"]+/g, ''));
      addresses[key] = value.replace(/^0x/, ''); // Strip 0x from the address
    });
    return addresses;
  }
  return null;
}

// Function to parse the YAML config file
function parseYaml(filePath) {
  const yamlContent = fs.readFileSync(filePath, 'utf-8');
  return yaml.load(yamlContent);
}

// Function to fetch account modules
async function getAccountModules(requestParameters, nodeUrl) {
  const client = new AptosClient(nodeUrl);
  const { address, ledgerVersion } = requestParameters;
  let ledgerVersionBig;
  if (ledgerVersion !== undefined) {
    ledgerVersionBig = BigInt(ledgerVersion);
  }
  return client.getAccountModules(address, { ledgerVersion: ledgerVersionBig });
}

// Function to fetch chainId from the REST API
async function fetchChainId(nodeUrl) {
  let url;
  if (nodeUrl.includes("movement")) {
    url = nodeUrl; // Use nodeUrl directly without appending '/v1'
  } else {
    url = `${nodeUrl}/v1`; // Default behavior, append '/v1'
  }
  const response = await axios.get(url);
  return response.data.chain_id;
}

// Function to get existing module data
function getExistingModulesData(filePath) {
  if (fs.existsSync(filePath)) {
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const match = fileContent.match(/deployedModules\s*=\s*({[\s\S]*});/);
    if (match && match[1]) {
      return JSON.parse(match[1]);
    }
  }
  return {};
}

// New function to write chain-specific modules
function writeChainModules(chainId, modules, isDeployed) {
  const chainDir = path.join(deploymentsDir, chainId.toString());
  if (!fs.existsSync(chainDir)) {
    fs.mkdirSync(chainDir, { recursive: true });
  }

  const fileName = isDeployed ? 'deployedModules.json' : 'externalModules.json';
  const filePath = path.join(chainDir, fileName);

  const moduleData = modules.reduce((acc, module) => {
    acc[module.abi.name] = {
      bytecode: module.bytecode,
      abi: module.abi
    };
    return acc;
  }, {});

  fs.writeFileSync(filePath, JSON.stringify(moduleData, null, 2), 'utf-8');
}

// Updated writeModules function
function writeModules(filePath, variableName) {
  const allChainDirs = fs.readdirSync(deploymentsDir);
  const allModules = {};

  allChainDirs.forEach(chainDir => {
    const chainModulesPath = path.join(deploymentsDir, chainDir, `${variableName}.json`);
    if (fs.existsSync(chainModulesPath)) {
      const chainModules = JSON.parse(fs.readFileSync(chainModulesPath, 'utf-8'));
      allModules[chainDir] = chainModules;
    }
  });

  // Generate file content
  const fileContent = `
  /**
   * This file is autogenerated.
   * You should not edit it manually or your changes might be overwritten.
   */
  import { GenericModulesDeclaration } from "~~/utils/scaffold-move/module";

  const ${variableName} = {
    ${Object.entries(allModules).reduce((content, [chainId, chainConfig]) => {
      return `${content}${parseInt(chainId).toFixed(0)}:${JSON.stringify(chainConfig, null, 2)},`;
    }, '')}
  } as const;

  export default ${variableName} satisfies GenericModulesDeclaration;
  `;

  fs.writeFileSync(filePath, fileContent.trim(), 'utf-8');
  }

// Main function to perform the tasks
async function main() {
  const config = parseYaml(configYamlPath);
  const nodeUrl = config.profiles.default.rest_url;
  const accountAddress = config.profiles.default.account.replace(/^0x/, ''); // Strip 0x from the account address

  const addresses = parseToml(moveTomlPath);

  // Fetch the chainId from the REST API
  const chainId = await fetchChainId(nodeUrl);

  // Ensure the output directory exists
  const outputDirectory = path.dirname(deployedModulesPath);
  if (!fs.existsSync(outputDirectory)) {
    fs.mkdirSync(outputDirectory, { recursive: true });
  }

  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  // Fetch and save account modules for the account from config.yaml
  const deployedModules = await getAccountModules({ address: accountAddress }, nodeUrl);
  writeChainModules(chainId, deployedModules, true);
  writeModules(deployedModulesPath, "deployedModules");
  console.log(`Data for deployed modules at address ${accountAddress} saved successfully.`);

  // Fetch and save account modules for each address from Move.toml, excluding the one from config.yaml
  console.log('Data for external modules:', loadExternalModules);
  if (loadExternalModules && addresses) {
    console.log('Loading external modules...');
    const externalModules = [];
    for (const [name, address] of Object.entries(addresses)) {
      if (address.toLowerCase() !== accountAddress.toLowerCase()) {
        const modules = await getAccountModules({ address }, nodeUrl);
        externalModules.push(...modules);
        console.log(`Data for address ${address} saved successfully.`);
      }
    }
    writeChainModules(chainId, externalModules, false);
    writeModules(externalModulesPath, "externalModules");
  }
}

main().catch(console.error);
