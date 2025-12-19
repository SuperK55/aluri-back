/**
 * Service Configuration Module
 * Defines service-specific settings, terminology, and resource mappings
 * for the multi-service platform (clinic, beauty_clinic, real_estate, insurance, consortia)
 */

export const SERVICE_CONFIG = {
  clinic: {
    name: 'Medical Clinic',
    resourceTable: 'doctors',
    resourceType: 'doctor',
    terminology: {
      resource: { singular: 'Doctor', plural: 'Doctors' },
      client: { singular: 'Patient', plural: 'Patients' },
      meeting: { singular: 'Appointment', plural: 'Appointments' }
    },
    fields: {
      primary: 'name',
      category: 'specialty',
      price: 'consultation_price',
      description: 'bio'
    },
    routes: {
      resources: '/api/doctors',
      legacySupport: true // Supports old /api/doctors routes
    }
  },
  
  beauty_clinic: {
    name: 'Beauty Clinic',
    resourceTable: 'treatments',
    resourceType: 'treatment',
    terminology: {
      resource: { singular: 'Treatment', plural: 'Treatments' },
      client: { singular: 'Client', plural: 'Clients' },
      meeting: { singular: 'Session', plural: 'Sessions' }
    },
    fields: {
      primary: 'name',
      category: 'main_category',
      price: 'price',
      description: 'description'
    },
    routes: {
      resources: '/api/beauty/treatments',
      legacySupport: false
    },
    categories: [
      'Laser',
      'Facial',
      'Body',
      'Facial Harmonization',
      'Body Harmonization',
      'Capillary / Trichology',
      'Intimate Rejuvenation',
      'Collagen Biostimulator',
      'Fillers / Threads',
      'Peeling',
      'Other'
    ],
    subcategories: [
      'Ultraformer',
      'Fotona',
      'Pulsed Light',
      'CO₂ Fractional',
      'PDO / PLLA Threads',
      'Morpheus',
      'Endolifting',
      'Permanent Hair Removal',
      'Phenol Peeling',
      'Radiesse Biostimulator',
      'Other'
    ],
    applicableAreas: [
      'Face',
      'Neck',
      'Abdomen',
      'Glutes',
      'Thighs',
      'Arms',
      'Armpits',
      'Intimate',
      'Other'
    ]
  },
  
  real_estate: {
    name: 'Real Estate',
    resourceTable: 'properties',
    resourceType: 'property',
    terminology: {
      resource: { singular: 'Property', plural: 'Properties' },
      client: { singular: 'Client', plural: 'Clients' },
      meeting: { singular: 'Showing', plural: 'Showings' }
    },
    fields: {
      primary: 'address',
      category: 'property_type',
      price: 'price',
      description: 'description'
    },
    routes: {
      resources: '/api/real-estate/properties',
      legacySupport: false
    }
  },
  
  insurance: {
    name: 'Insurance',
    resourceTable: 'insurance_plans',
    resourceType: 'insurance_plan',
    terminology: {
      resource: { singular: 'Plan', plural: 'Plans' },
      client: { singular: 'Client', plural: 'Clients' },
      meeting: { singular: 'Consultation', plural: 'Consultations' }
    },
    fields: {
      primary: 'name',
      category: 'insurance_type',
      price: 'premium',
      description: 'description'
    },
    routes: {
      resources: '/api/insurance/plans',
      legacySupport: false
    }
  },
  
  consortia: {
    name: 'Consortia',
    resourceTable: 'consortia_plans',
    resourceType: 'consortia_plan',
    terminology: {
      resource: { singular: 'Plan', plural: 'Plans' },
      client: { singular: 'Member', plural: 'Members' },
      meeting: { singular: 'Meeting', plural: 'Meetings' }
    },
    fields: {
      primary: 'name',
      category: 'consortia_type',
      price: 'monthly_payment',
      description: 'description'
    },
    routes: {
      resources: '/api/consortia/plans',
      legacySupport: false
    }
  }
};

/**
 * Get service configuration by service type
 * @param {string} serviceType - The service type (clinic, beauty_clinic, etc.)
 * @returns {object} Service configuration object
 */
export const getServiceConfig = (serviceType) => {
  return SERVICE_CONFIG[serviceType] || SERVICE_CONFIG.clinic;
};

/**
 * Get service terminology for agent conversation flows
 * @param {string} serviceType - The service type
 * @returns {object} Terminology object with singular/plural forms
 */
export const getServiceTerminology = (serviceType) => {
  const config = getServiceConfig(serviceType);
  return config.terminology;
};

/**
 * Validate if a service type is supported
 * @param {string} serviceType - The service type to validate
 * @returns {boolean} True if service type is valid
 */
export const isValidServiceType = (serviceType) => {
  return Object.keys(SERVICE_CONFIG).includes(serviceType);
};

/**
 * Get all supported service types
 * @returns {string[]} Array of service type keys
 */
export const getSupportedServiceTypes = () => {
  return Object.keys(SERVICE_CONFIG);
};

