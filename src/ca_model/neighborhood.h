#ifndef NEIGHBORHOOD_H
#define NEIGHBORHOOD_H

#include <string>
#include <vector>

struct Neighborhood {
  Neighborhood (std::string id_name, std::string description, std::vector<std::pair<int,int>>* neighbor_coords) {
    m_id_name = id_name;
    std::replace(m_id_name.begin(), m_id_name.end(), ' ', '_');

    m_description = description;

    m_neighbor_coords = neighbor_coords;
  }

  ~Neighborhood() { delete m_neighbor_coords; }

  std::string                              m_id_name;
  std::string                              m_description;
  std::vector<std::pair<int,int>>*         m_neighbor_coords;
};

#endif // NEIGHBORHOOD_H
